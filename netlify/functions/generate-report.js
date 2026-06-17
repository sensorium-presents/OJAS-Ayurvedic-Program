// netlify/functions/generate-report.js
//
// Generates a structured weekly OJAS Report from the user's week of data.
// Called at end of each 7-day phase.
//
// Receives: { apiKey, model, weekData, userProfile, phase }
// weekData: { mealRatings, workoutRatings, journalEntries,
//             checkboxCompletions, supplementCompliance }
//
// Returns: { report: { findings, adjustments, topMeals, topWorkouts,
//                      patterns, researchCitations, clarifierQuestions } }

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { apiKey, model, weekData, userProfile, phase } = body;

    if (!apiKey || !model || !weekData || !userProfile) {
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

    const systemPrompt = buildReportSystemPrompt();
    const userPrompt = buildReportPrompt(weekData, userProfile, phase);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errData = await response.json();
      const msg = errData.error?.message || 'API error';
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: msg })
      };
    }

    const data = await response.json();
    const rawText = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    let report;
    try {
      const cleaned = rawText
        .replace(/^```json\s*/m, '')
        .replace(/^```\s*/m, '')
        .replace(/```\s*$/m, '')
        .trim();
      report = JSON.parse(cleaned);
    } catch(e) {
      report = buildFallbackReport(weekData, phase);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ report })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

function buildReportSystemPrompt() {
  return `You are ZenZo, an expert Ayurvedic wellness analyst and practitioner.
Your task is to analyze one week of a user's OJAS program data and generate a structured weekly report.

CRITICAL RULES:
1. Return ONLY valid JSON. No markdown, no preamble, no explanation.
2. Every finding must cite a real, named source. Use this format:
   - Classical: "Charaka Samhita, Sutrasthana 6.4" or "Ashtanga Hridayam, Sutrasthana 8"
   - Modern: "Journal of Ayurveda and Integrative Medicine, 2023" or "Evidence-Based Complementary and Alternative Medicine, 2024"
   - Specific researchers: "Manyam BV (2023)" or "Pole S, Ayurvedic Medicine (2013)"
   - If you cannot name a real source, use: "traditional Ayurvedic practice — no recent citation available"
   - NEVER fabricate a citation. If uncertain, say so explicitly.
3. Psychological analysis must be grounded in observable data (journal language, rating patterns, completion gaps).
4. The 3-5 clarifier questions must be specific to THIS user's week, not generic.
5. Tone: warm, honest, direct. Like a knowledgeable friend who has looked at your data carefully.`;
}

function buildReportPrompt(weekData, userProfile, phase) {
  const phaseName = ['','Purification & Foundation','Building Momentum',
    'Integration','Peak Practice','Consolidation'][phase] || 'Unknown';
  const doshaNames = {p:'Pitta', k:'Kapha', v:'Vata'};
  const primary = doshaNames[userProfile.dosha_primary] || 'Unknown';
  const secondary = doshaNames[userProfile.dosha_secondary] || 'Unknown';

  // Summarize meal ratings
  const mealSummary = (weekData.mealRatings || []).map(r =>
    `${r.meal_category} — "${r.meal_name}" rated ${r.rating}/5${r.notes ? ` (note: "${r.notes}")` : ''}`
  ).join('\n') || 'No meal ratings recorded';

  // Summarize workout ratings
  const workoutSummary = (weekData.workoutRatings || []).map(r =>
    `${r.workout_name} rated ${r.rating}/5, modified: ${r.was_modified}`
  ).join('\n') || 'No workout ratings recorded';

  // Summarize journals
  const journalSummary = Object.entries(weekData.journalEntries || {})
    .map(([day, entry]) => `Day ${day}: "${entry.substring(0, 200)}${entry.length > 200 ? '...' : ''}"`)
    .join('\n') || 'No journal entries recorded';

  // Completion stats
  const completion = weekData.checkboxCompletions || {};
  const totalChecked = Object.values(completion).filter(v => v === true).length;
  const totalTasks = Object.keys(completion).length;
  const completionPct = totalTasks > 0 ? Math.round((totalChecked/totalTasks)*100) : 0;

  // Supplement compliance
  const suppCompliance = weekData.supplementCompliance || {};
  const suppSummary = Object.entries(suppCompliance)
    .map(([name, days]) => `${name}: taken ${days}/7 days`)
    .join(', ') || 'No supplement data';

  return `Analyze Week ${phase} (${phaseName}) for this OJAS user.

USER CONSTITUTION: ${primary}-${secondary}-${doshaNames[userProfile.dosha_tertiary] || 'Unknown'}
PRIMARY: ${primary} (${userProfile.pitta_pct || 0}%) | SECONDARY: ${secondary} (${userProfile.kapha_pct || 0}%)
FOCUS AREAS: ${(userProfile.intent_selections || []).join(', ') || 'not set'}

WEEK ${phase} DATA:

TASK COMPLETION: ${totalChecked}/${totalTasks} tasks (${completionPct}%)

MEAL RATINGS:
${mealSummary}

WORKOUT RATINGS:
${workoutSummary}

SUPPLEMENT COMPLIANCE:
${suppSummary}

JOURNAL ENTRIES:
${journalSummary}

Generate a structured weekly report as this exact JSON:

{
  "week": ${phase},
  "phase_name": "${phaseName}",
  "completion_score": ${completionPct},
  "overall_summary": "2-3 sentence honest assessment of this week",

  "top_meals": [
    {"name": "meal name", "category": "breakfast/lunch/snack/dinner", "rating": 0, "why_it_worked": "brief reason"},
    {"name": "meal name", "category": "", "rating": 0, "why_it_worked": ""}
  ],

  "top_workouts": [
    {"name": "workout name", "rating": 0, "why_it_worked": "brief reason"}
  ],

  "patterns_observed": [
    {
      "pattern": "Specific observable pattern from the data",
      "significance": "What this suggests about their constitution or current state",
      "citation": "Real named source",
      "citation_year": "2023",
      "confidence": "well-established | traditionally-supported | emerging-evidence | anecdotal"
    }
  ],

  "adjustments_proposed": [
    {
      "area": "nutrition | movement | sleep | supplements | mental | skincare",
      "current": "What was done this week",
      "proposed": "What should change next week",
      "reason": "Why this change makes sense based on the data",
      "citation": "Real named source",
      "citation_year": "2024"
    }
  ],

  "psychological_read": {
    "observed_state": "What the journal language and rating patterns reveal about their mindset this week",
    "readiness_signal": "high | moderate | cautious | needs-support",
    "key_tension": "The gap between what the data shows and what the person expressed (if any)",
    "what_to_listen_for": "What to probe in the clarification conversation"
  },

  "clarifier_questions": [
    {
      "question": "Specific question based on a real pattern from this week's data",
      "why_asking": "What this will reveal that would change the next week's program",
      "area": "nutrition | movement | mental | lifestyle | supplements"
    }
  ],

  "zenzo_opening": "How ZenZo will open the clarification conversation — warm, specific to this week, referencing something real from their data"
}

Generate exactly 3-5 patterns_observed, 2-4 adjustments_proposed, and 3-5 clarifier_questions.
Make every finding specific to THIS user's actual data, not generic.`;
}

function buildFallbackReport(weekData, phase) {
  const phaseName = ['','Purification & Foundation','Building Momentum',
    'Integration','Peak Practice','Consolidation'][phase] || 'Week ' + phase;
  const totalTasks = Object.keys(weekData.checkboxCompletions || {}).length;
  const totalChecked = Object.values(weekData.checkboxCompletions || {}).filter(v => v === true).length;
  const pct = totalTasks > 0 ? Math.round((totalChecked/totalTasks)*100) : 0;

  return {
    week: phase,
    phase_name: phaseName,
    completion_score: pct,
    overall_summary: `You completed ${pct}% of Week ${phase}. Your data has been collected and is ready for review. Use this report to reflect on what worked and what needs adjustment.`,
    top_meals: [],
    top_workouts: [],
    patterns_observed: [
      {
        pattern: "Week " + phase + " completed with " + pct + "% task completion",
        significance: "Consistency is the foundation of constitutional alignment in Ayurveda",
        citation: "Charaka Samhita, Sutrasthana 7.3 — on the importance of dinacharya consistency",
        citation_year: "classical",
        confidence: "well-established"
      }
    ],
    adjustments_proposed: [
      {
        area: "nutrition",
        current: "Week " + phase + " meal protocol",
        proposed: "Continue building on meals that resonated, introduce variation in week " + (phase + 1),
        reason: "Rating patterns will guide which meals to carry forward",
        citation: "Ashtanga Hridayam, Ahara chapter",
        citation_year: "classical"
      }
    ],
    psychological_read: {
      observed_state: "Data collected — awaiting your reflection on how the week felt",
      readiness_signal: "moderate",
      key_tension: "None identified without fuller journal data",
      what_to_listen_for: "Energy, motivation, any resistance to specific practices"
    },
    clarifier_questions: [
      {
        question: "How did your energy feel across the week — was there a pattern to when you felt most and least vital?",
        why_asking: "Energy patterns reveal Agni strength and whether the meal timing is well-calibrated",
        area: "nutrition"
      },
      {
        question: "Which single practice from this week felt most natural to you — like something you could see doing forever?",
        why_asking: "Identifying natural fits helps anchor Week " + (phase+1) + " around practices that have already become embodied",
        area: "lifestyle"
      },
      {
        question: "Was there anything in the program this week that you found yourself resisting or consistently skipping? What was underneath that?",
        why_asking: "Resistance data is as important as completion data — it reveals where the program needs calibration",
        area: "mental"
      }
    ],
    zenzo_opening: "I have been looking at your Week " + phase + " data. Before I build next week, I want to hear from you directly — your ratings and journal tell me one story, but you always know more than the numbers do. Can we talk through what this week actually felt like?"
  };
}
