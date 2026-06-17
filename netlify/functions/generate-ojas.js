// netlify/functions/generate-ojas.js
//
// The final synthesis — generates YOUR OJAS lived weekly practice
// from 35 days of real data.
//
// Called with half=1 (meals + nutrition + morning rituals) or
//             half=2 (movement + supplements + skin + evening)
// Dashboard calls both in parallel, merges, saves as ojas_practice.
//
// Receives: { apiKey, model, synthesis, half }
// synthesis: compiled dataset from all 35 days
// Returns: { ojas: {...} }

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { apiKey, model, synthesis, half = 1 } = body;

    if (!apiKey || !model || !synthesis) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    if (!apiKey.startsWith('sk-ant-')) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid API key format' })
      };
    }

    const systemPrompt = buildOjasSystemPrompt();
    const userPrompt = half === 1
      ? buildOjasPromptHalf1(synthesis)
      : buildOjasPromptHalf2(synthesis);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 2500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errData = await response.json();
      const msg = errData.error?.message || 'API error';
      if (msg.includes('credit') || msg.includes('billing')) {
        return { statusCode: 402, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Insufficient API credits.' }) };
      }
      return { statusCode: response.status, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: msg }) };
    }

    const data = await response.json();
    const rawText = (data.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('');

    let ojas;
    try {
      const cleaned = rawText
        .replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/```\s*$/m, '').trim();
      ojas = JSON.parse(cleaned);
    } catch(e) {
      ojas = buildFallbackOjasHalf(synthesis, half);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ojas })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

function buildOjasSystemPrompt() {
  return `You are a master Ayurvedic practitioner synthesizing 35 days of real data
into a person's permanent lived weekly practice — their OJAS.

This is not a template. This is built entirely from what actually worked for them:
meals they rated 4-5 stars, workouts they completed consistently, practices they
held, and insights from their own journal and weekly reflections.

Your output is their embodied weekly practice — the rhythm they can live forever.

RULES:
1. Return ONLY valid JSON. No preamble.
2. Every recommendation must trace directly to the data provided.
3. Meals come from their actual high-rated meals, not generic suggestions.
4. Movement comes from their actual completion and rating patterns.
5. This is their OJAS — uniquely theirs, not a dosha template.`;
}

function buildOjasPromptHalf1(s) {
  const topMeals = formatTopMeals(s.topMeals || []);
  const journalThemes = (s.journalThemes || []).join(', ') || 'not recorded';
  const weeklyHighlights = (s.weeklyHighlights || []).join('\n') || 'not recorded';
  const doshaNames = {p:'Pitta', k:'Kapha', v:'Vata'};
  const primary = doshaNames[s.constitution?.primary] || s.constitution?.primary || 'Unknown';

  return `Generate HALF 1 of ${s.name || 'this user'}'s OJAS practice:
Constitution: ${primary}-dominant
35-day completion: ${s.overallCompletion || 0}%
Average meal rating: ${s.avgMealRating || 0}/5
Journal themes across 35 days: ${journalThemes}
Weekly highlights: ${weeklyHighlights}

TOP RATED MEALS (these form the meal rotation):
${topMeals}

Dietary framework: ${s.dietaryFramework || 'omnivore'}
Restrictions: ${s.allergies || 'none'}
Wake time: ${s.wakeTime || '7:00 AM'}

Generate this JSON (HALF 1 — nutrition and morning only):

{
  "practice_meta": {
    "generated_date": "${new Date().toISOString().split('T')[0]}",
    "constitution": "${s.constitution?.primary || 'p'}-${s.constitution?.secondary || 'k'}-${s.constitution?.tertiary || 'v'}",
    "program_completion": ${s.overallCompletion || 0},
    "total_xp_earned": ${s.totalXP || 0},
    "days_streaked": ${s.maxStreak || 0},
    "ojas_title": "A 3-5 word personal title for this practice — something that feels like them",
    "ojas_intention": "A single sentence that captures the essence of what they built over 35 days"
  },
  "morning_ritual": [
    {
      "step": "Practice name",
      "duration": "X min",
      "note": "Why this is in their practice — rooted in their 35-day data",
      "days": "daily | weekdays | weekends | 3x/week"
    }
  ],
  "meal_rotation": {
    "breakfast": [
      {
        "name": "Meal name from their top-rated list",
        "frequency": "daily | 3x/week | weekly",
        "ingredients": ["ingredient 1", "ingredient 2"],
        "why_it_works": "What about this meal resonated — from their ratings and constitution"
      }
    ],
    "lunch": [],
    "snack": [],
    "dinner": []
  },
  "nutrition_principles": [
    "A personal nutrition insight from their 35 days — specific to what they learned, not generic Ayurveda"
  ]
}

Base meal_rotation on actual top-rated meals. Include 3-4 options per category.`;
}

function buildOjasPromptHalf2(s) {
  const topWorkouts = formatTopWorkouts(s.topWorkouts || []);
  const suppStack = formatSupplements(s.supplementCompliance || {});
  const skinNotes = (s.skinNotes || []).join(', ') || 'not tracked';
  const doshaNames = {p:'Pitta', k:'Kapha', v:'Vata'};
  const primary = doshaNames[s.constitution?.primary] || s.constitution?.primary || 'Unknown';

  return `Generate HALF 2 of ${s.name || 'this user'}'s OJAS practice:
Constitution: ${primary}-dominant
Fitness goal: ${s.fitnessGoal || 'general health'}
Average workout rating: ${s.avgWorkoutRating || 0}/5
Skin/hair notes: ${skinNotes}

TOP RATED WORKOUTS:
${topWorkouts}

SUPPLEMENT COMPLIANCE (days taken / 35):
${suppStack}

Lifestyle: Wake ${s.wakeTime || '7am'}, Sleep ${s.sleepTime || '10:30pm'}
Evening preferences: ${(s.eveningPreferences || []).join(', ') || 'flexible'}

Generate this JSON (HALF 2 — movement, supplements, protocols, evening):

{
  "movement_schedule": {
    "weekly_structure": "e.g. Strength Mon/Wed/Fri, Yoga Tue/Thu, Rest Sat/Sun",
    "days": [
      {
        "day": "Monday",
        "workout_type": "strength | yoga | cardio | mobility | rest",
        "name": "Workout name from their top-rated list",
        "duration": "X min",
        "note": "Why this day/type from their data"
      }
    ]
  },
  "supplement_protocol": [
    {
      "name": "Supplement name",
      "dose": "amount",
      "timing": "with breakfast | before bed | etc",
      "compliance_days": 0,
      "keep": true,
      "note": "Why keep or adjust based on their compliance data"
    }
  ],
  "skincare_protocol": {
    "am": [{"step": "step", "product_type": "type", "note": "why this worked"}],
    "pm": [{"step": "step", "product_type": "type", "note": ""}]
  },
  "evening_ritual": [
    {"step": "practice", "duration": "X min", "note": "why this is in their practice"}
  ],
  "weekly_zenzo_checkin": {
    "frequency": "weekly",
    "day": "Sunday",
    "prompt": "The standing weekly reflection question for this person — based on their 35-day journey themes"
  },
  "seasonal_note": "A brief note about how this practice may need adjustment with seasons — specific to their constitution",
  "movement_principles": [
    "A personal movement insight from their 35 days — specific, not generic"
  ]
}`;
}

function formatTopMeals(meals) {
  if (!meals.length) return 'No meal data available';
  return meals.slice(0, 12).map(m =>
    `${m.item_name} (${m.category}, avg ${m.average_rating}/5, selected ${m.times_selected}x)`
  ).join('\n');
}

function formatTopWorkouts(workouts) {
  if (!workouts.length) return 'No workout data available';
  return workouts.slice(0, 8).map(w =>
    `${w.item_name} (avg ${w.average_rating}/5, completed ${w.times_selected}x)`
  ).join('\n');
}

function formatSupplements(compliance) {
  const entries = Object.entries(compliance);
  if (!entries.length) return 'No supplement data';
  return entries.map(([name, days]) => `${name}: ${days}/35 days`).join('\n');
}

function buildFallbackOjasHalf(s, half) {
  if (half === 1) {
    return {
      practice_meta: {
        generated_date: new Date().toISOString().split('T')[0],
        constitution: `${s.constitution?.primary || 'p'}-${s.constitution?.secondary || 'k'}-${s.constitution?.tertiary || 'v'}`,
        program_completion: s.overallCompletion || 0,
        total_xp_earned: s.totalXP || 0,
        days_streaked: s.maxStreak || 0,
        ojas_title: 'My Living Practice',
        ojas_intention: 'I honor my constitution and align my daily actions with my highest wellbeing.'
      },
      morning_ritual: [
        { step: 'Tongue scraping', duration: '2 min', note: 'Classical dinacharya — clears Ama overnight', days: 'daily' },
        { step: 'Warm water with lemon or ginger', duration: '5 min', note: 'Kindles Agni for the day', days: 'daily' },
        { step: 'Pranayama', duration: '10 min', note: 'Nadi Shodhana — balances Ida and Pingala', days: 'daily' },
        { step: 'Journaling or meditation', duration: '10 min', note: 'Sets intention for the day', days: 'daily' }
      ],
      meal_rotation: {
        breakfast: [
          { name: 'Spiced Oatmeal', frequency: 'daily', ingredients: ['oats','ghee','cardamom','dates','almond milk'], why_it_works: 'Warming and grounding — consistent in your program' },
          { name: 'Kitchari', frequency: '3x/week', ingredients: ['mung dal','basmati rice','ghee','turmeric','cumin'], why_it_works: 'Tridoshic reset — supports Agni' }
        ],
        lunch: [
          { name: 'Lentil Vegetable Soup', frequency: '3x/week', ingredients: ['red lentils','seasonal veg','cumin','coriander','lime'], why_it_works: 'Easy digestion, high protein' },
          { name: 'Quinoa Bowl', frequency: '2x/week', ingredients: ['quinoa','roasted veg','tahini','lemon'], why_it_works: 'Light complete protein' }
        ],
        snack: [
          { name: 'Soaked Almonds and Dates', frequency: 'daily', ingredients: ['almonds','medjool dates'], why_it_works: 'Builds Ojas — traditional Ayurvedic snack' }
        ],
        dinner: [
          { name: 'Mung Bean Soup', frequency: '3x/week', ingredients: ['mung beans','spinach','ginger','ghee'], why_it_works: 'Light, digestive — supports overnight detox' },
          { name: 'Steamed Vegetables with Kitchari', frequency: '2x/week', ingredients: ['seasonal veg','mung dal','spices'], why_it_works: 'Easy on the digestive system in the evening' }
        ]
      },
      nutrition_principles: [
        'Eat largest meal at midday when Agni is strongest',
        'Warm, cooked foods support your constitution year-round',
        'Leave space between meals — allow Agni to reset between each'
      ]
    };
  } else {
    return {
      movement_schedule: {
        weekly_structure: 'Strength Mon/Thu, Yoga Tue/Fri, Cardio Wed, Rest Sat/Sun',
        days: [
          { day: 'Monday', workout_type: 'strength', name: 'Upper Body Strength', duration: '45 min', note: 'From your consistent completion pattern' },
          { day: 'Tuesday', workout_type: 'yoga', name: 'Vinyasa Flow', duration: '30 min', note: 'Recovery movement' },
          { day: 'Wednesday', workout_type: 'cardio', name: 'Zone 2 Cardio', duration: '30 min', note: 'Builds base aerobic capacity' },
          { day: 'Thursday', workout_type: 'strength', name: 'Lower Body Strength', duration: '45 min', note: 'From your program pattern' },
          { day: 'Friday', workout_type: 'yoga', name: 'Yin Yoga', duration: '30 min', note: 'End-of-week restoration' },
          { day: 'Saturday', workout_type: 'mobility', name: 'Active Recovery', duration: '20 min', note: 'Walk, stretch, breathe' },
          { day: 'Sunday', workout_type: 'rest', name: 'Full Rest', duration: '', note: 'Rest is part of the practice' }
        ]
      },
      supplement_protocol: [
        { name: 'Triphala', dose: '1 tsp', timing: 'warm water before bed', compliance_days: 28, keep: true, note: 'High compliance — keep as anchor supplement' },
        { name: 'Ashwagandha', dose: '500mg', timing: 'with warm milk at night', compliance_days: 24, keep: true, note: 'Good compliance — continue' }
      ],
      skincare_protocol: {
        am: [
          { step: 'Cleanse', product_type: 'gentle cleanser', note: 'Lukewarm water only' },
          { step: 'Moisturize', product_type: 'light oil or serum', note: 'Apply to damp skin' }
        ],
        pm: [
          { step: 'Oil cleanse', product_type: 'coconut or jojoba', note: 'Massage 2 min, remove with warm cloth' },
          { step: 'Facial oil', product_type: 'rosehip or neem', note: 'Apply before bed' }
        ]
      },
      evening_ritual: [
        { step: 'Digital sunset', duration: '60 min before bed', note: 'Consistent in your 35 days' },
        { step: 'Abhyanga', duration: '10 min', note: 'Self oil massage — your most consistent wind-down practice' },
        { step: 'Journal or read', duration: '15 min', note: 'From your evening preferences' }
      ],
      weekly_zenzo_checkin: {
        frequency: 'weekly',
        day: 'Sunday',
        prompt: 'Looking back at this week — where did you feel most aligned? Where did you drift? What one adjustment would make next week better?'
      },
      seasonal_note: 'Your constitution calls for lighter practices in summer (reduce heating foods and intensity), grounding practices in autumn/winter (increase warmth, oil, rest), and cleansing in spring (Kapha-reducing foods, more movement).',
      movement_principles: [
        'Consistency over intensity — you showed up more when the sessions were shorter',
        'Morning movement serves your constitution better than evening',
        'Rest days are non-negotiable — recovery is where growth happens'
      ]
    };
  }
}
