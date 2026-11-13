// Reads photos of a cookbook page or a store-bought meal's box with Claude
// and returns the recipe fields for the admin to check before saving.
// Called by the site as POST /.netlify/functions/recipe-photo  { images:[{media_type, data}] }
//
// Netlify environment variables:
//   ANTHROPIC_API_KEY          from console.anthropic.com (keep secret)
//   CLAUDE_MODEL (optional)    defaults to claude-haiku-5-5
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY   (already set for the calendar)

const SECTIONS = ['produce', 'meat', 'dairy', 'bakery', 'pantry', 'frozen', 'other'];

const PROMPT = `You read photos of cookbook pages or store-bought meal packaging for a family meal planner. Return one JSON object and nothing else.

Fields:
- name: the dish or product name
- type: "homemade" for a recipe, "prepackaged" for a store-bought meal
- store: the store or brand of a prepackaged meal, else null
- cook_method: for a prepackaged meal, how it's cooked ("Oven", "Microwave", "Skillet", "Air fryer"), else null
- prep_min, cook_min: minutes as numbers. Use printed times; if none are printed, estimate and set time_estimated to true.
- servings: number of servings (for packaging, servings per container)
- ingredients: for a homemade recipe, a list of {quantity, unit, ingredient, section}. quantity is a number (1 1/2 becomes 1.5) or null. unit is short ("cup", "tbsp", "tsp", "lb", "oz", "clove", "can") or null. ingredient is the item name, with prep notes after it ("onion, chopped"). section is one of produce, meat, dairy, bakery, pantry, frozen, other. For a prepackaged meal, use [].
- instructions: the steps as plain text, one step per line. For packaging, the cooking directions.
- protein_g, carbs_g, fat_g, calories: per serving, as numbers. If a Nutrition Facts label or nutrition line is shown, use it and set macros_estimated to false. Otherwise estimate from the ingredients and servings using standard USDA values and set macros_estimated to true.
- time_estimated, macros_estimated: true or false

Use null for anything not shown that can't reasonably be estimated. Don't add ingredients that aren't shown.
If the photos show no recipe or food product, return {"error": "No recipe or meal found in the photo."}`;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const user = await verify(req);
  if (!user || user.role !== 'admin') return json({ error: 'Only Mom and Dad can add recipes.' }, 403);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'Photo reading isn’t set up yet (missing API key).' }, 503);

  let images;
  try { ({ images } = await req.json()); } catch { return json({ error: 'Bad request' }, 400); }
  if (!Array.isArray(images) || !images.length || images.length > 4) return json({ error: 'Send 1 to 4 photos.' }, 400);
  const ok = images.every((i) => ['image/jpeg', 'image/png', 'image/webp'].includes(i?.media_type) && typeof i.data === 'string');
  if (!ok) return json({ error: 'Photos must be JPEG, PNG or WebP.' }, 400);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
      max_tokens: 3000,
      system: PROMPT,
      messages: [{
        role: 'user',
        content: [
          ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })),
          { type: 'text', text: 'Read these photos and return the JSON.' },
        ],
      }],
    }),
  });
  if (!res.ok) {
    console.error('Claude API error', res.status, (await res.text()).slice(0, 500));
    return json({ error: 'Claude couldn’t read the photo right now. Try again in a minute.' }, 502);
  }

  const data = await res.json();
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const clean = text.replace(/```json|```/g, '');
  try {
    const out = JSON.parse(clean.slice(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
    if (out.error) return json({ error: String(out.error).slice(0, 200) }, 422);
    return json(sanitize(out));
  } catch {
    return json({ error: 'Couldn’t make sense of that photo. Try a clearer, closer shot.' }, 502);
  }
};

async function verify(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${token}` };
  const u = await fetch(`${base}/auth/v1/user`, { headers });
  if (!u.ok) return null;
  const { id } = await u.json();
  const p = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=role`, { headers });
  const rows = p.ok ? await p.json() : [];
  return { id, role: rows[0]?.role || 'member' };
}

const num = (v, whole) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n) || n < 0) return null;
  return whole ? Math.round(n) : Math.round(n * 100) / 100;
};
const str = (v, max = 4000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function sanitize(o) {
  return {
    name: str(o.name, 120),
    type: o.type === 'prepackaged' ? 'prepackaged' : 'homemade',
    store: str(o.store, 80),
    cook_method: str(o.cook_method, 40),
    prep_min: num(o.prep_min, true),
    cook_min: num(o.cook_min, true),
    servings: num(o.servings, true),
    time_estimated: !!o.time_estimated,
    protein_g: num(o.protein_g),
    carbs_g: num(o.carbs_g),
    fat_g: num(o.fat_g),
    calories: num(o.calories, true),
    macros_estimated: !!o.macros_estimated,
    instructions: str(o.instructions),
    ingredients: (Array.isArray(o.ingredients) ? o.ingredients : []).slice(0, 60).map((i) => ({
      quantity: num(i?.quantity),
      unit: str(i?.unit, 20),
      ingredient: str(i?.ingredient, 120),
      section: SECTIONS.includes(i?.section) ? i.section : 'other',
    })).filter((i) => i.ingredient),
  };
}
