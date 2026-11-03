import { WorkshopStep, WorkshopUnit } from '../ai/workshop.prompts';

/**
 * What Lora SAYS during the internship. Built straight from the content the AI
 * already wrote (no extra AI call, no extra token), so her voice can start the
 * instant a learner opens a step. Code is never read out symbol by symbol -
 * she describes what it does and why - and each script is kept short enough to
 * listen to comfortably.
 *
 * These strings go through the TTS cache keyed by their text, so a given script
 * is only ever synthesized once per voice.
 */

const clip = (s: string | undefined, max: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + '...' : t;
};
const sentence = (s: string | undefined) => {
  const t = (s ?? '').trim();
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
};

export function loraIntroScript(firstName: string | undefined, courseTitle: string, totalLevels: number, totalProjects: number): string {
  const name = firstName?.trim();
  return [
    name ? `Hi ${name}!` : 'Hi there!',
    `I'm Lora, and I'll be your supervisor for your internship program in ${courseTitle}.`,
    `I'll be with you the whole way, from your very first step to your final project.`,
    `Here is how it works. There are ${totalLevels} practical levels, from beginner to super advanced, and then ${totalProjects} real-world projects.`,
    `At every step I'll tell you exactly what to do, what to type and why, and what it does. Then you show me your work, and I'll review it straight away.`,
    `When you finish everything, you can apply for your internship document.`,
    `Whenever you're stuck, just ask me. Let's get started!`,
  ].join(' ');
}

export function loraUnitScript(unit: WorkshopUnit, firstName?: string): string {
  const stepCount = unit.steps?.length ?? unit.outline.length;
  if (unit.kind === 'project') {
    return [
      `Alright${firstName ? ` ${firstName}` : ''}, this is a real project: ${unit.title}.`,
      unit.role ? `In this project you're playing the role of ${clip(unit.role, 140)}.` : '',
      sentence(clip(unit.scenario, 420)),
      unit.deliverables?.length ? `By the end, you'll have built: ${unit.deliverables.slice(0, 4).map((d) => clip(d, 90)).join('; ')}.` : '',
      `We'll do it in ${stepCount} steps, and I'll guide you through every one. Ready? Let's begin with step one.`,
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    `Welcome to the ${unit.tier} level: ${unit.title}.`,
    sentence(clip(unit.summary, 300)),
    unit.outcomes.length ? `By the end of this level you'll be able to: ${unit.outcomes.slice(0, 3).map((o) => clip(o, 90)).join('; ')}.` : '',
    `There ${stepCount === 1 ? 'is 1 step' : `are ${stepCount} steps`}. I'll walk you through each one. Let's start with step one.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** The spoken lesson for one step: what we're doing, why, what to do, what the code does and why, and what to check. */
export function loraStepScript(step: WorkshopStep, stepNumber: number, totalSteps: number): string {
  const parts: string[] = [];
  parts.push(`Step ${stepNumber} of ${totalSteps}: ${step.title}.`);
  if (step.objective) parts.push(sentence(clip(step.objective, 260)));
  if (step.whyItMatters) parts.push(`Here's why this matters. ${sentence(clip(step.whyItMatters, 380))}`);

  if (step.actions?.length) {
    parts.push('Here is what to do.');
    const acts = step.actions.slice(0, 7);
    acts.forEach((a, i) => {
      const lead = i === 0 ? 'First' : i === acts.length - 1 ? 'Finally' : 'Next';
      parts.push(`${lead}, ${sentence(clip(a.replace(/^[A-Z]/, (c) => c.toLowerCase()), 220))}`);
    });
  }

  if (step.artifact) {
    parts.push(
      `Now the code. You'll ${/new file/i.test(step.artifact.placement) ? 'create' : 'work in'} ${step.artifact.fileName}. I've put it on your screen, so you can copy it.`,
    );
    if (step.artifact.whatItDoes) parts.push(`What it does: ${sentence(clip(step.artifact.whatItDoes, 340))}`);
    if (step.artifact.whyWeWriteIt) parts.push(`Why we write it: ${sentence(clip(step.artifact.whyWeWriteIt, 340))}`);
    const walk = step.artifact.walkthrough.slice(0, 3);
    if (walk.length) {
      parts.push("Let me explain the key parts.");
      walk.forEach((w) => parts.push(`${clip(w.part, 80)}: ${sentence(clip(w.explanation, 240))}`));
      if (step.artifact.walkthrough.length > 3) parts.push('The rest is explained in the walkthrough on your screen.');
    }
  }

  if (step.terminal?.length) {
    parts.push(
      `In the terminal section you'll run ${step.terminal.length === 1 ? 'one command' : `${step.terminal.length} commands`}. ${step.terminal
        .slice(0, 3)
        .map((t, i) => `Command ${i + 1}: ${sentence(clip(t.explanation, 200))}`)
        .join(' ')}`,
    );
  }

  if (step.expectedOutcome) parts.push(`When it works, you should see: ${sentence(clip(step.expectedOutcome, 260))}`);
  if (step.checkpoint?.task) parts.push(`When you're done, show me. Your checkpoint: ${sentence(clip(step.checkpoint.task, 260))} Paste it in and submit, and I'll review it right away.`);
  if (stepNumber === 1) parts.push("And remember, if anything is unclear, just ask me.");
  return parts.join(' ');
}

export function loraFeedbackScript(args: {
  firstName?: string;
  passed: boolean;
  score: number;
  feedback: string;
  toFix: string[];
  corrections?: Array<{ problem: string; why: string; fix: string }>;
  nextTip?: string;
  hasNext: boolean;
}): string {
  const name = args.firstName ? ` ${args.firstName}` : '';
  if (args.passed) {
    return [
      `Well done${name}! You scored ${args.score} out of 100, and that's a pass.`,
      sentence(clip(args.feedback, 520)),
      args.nextTip ? `Pro tip: ${sentence(clip(args.nextTip, 240))}` : '',
      args.hasNext ? "Whenever you're ready, move on to the next step." : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    `Not quite yet${name}. You scored ${args.score} out of 100, and you need 70 to pass.`,
    sentence(clip(args.feedback, 520)),
    ...explainCorrections(args.corrections, args.toFix),
    "Take your time and have another go. I've written every correction out on your screen, and you can ask me about any of them. You can do this.",
  ]
    .filter(Boolean)
    .join(' ');
}

/** Lora talks through the top corrections: what is wrong, why, and how to fix it. */
function explainCorrections(corrections: Array<{ problem: string; why: string; fix: string }> | undefined, toFix: string[]): string[] {
  if (corrections?.length) {
    const top = corrections.slice(0, 2);
    const out = top.map((c, i) =>
      `${i === 0 ? 'First' : 'Second'}: ${sentence(clip(c.problem, 220))} ${c.why ? `Here's why: ${sentence(clip(c.why, 260))}` : ''} ${c.fix ? `To fix it: ${sentence(clip(c.fix, 260))}` : ''}`.replace(/\s+/g, ' ').trim(),
    );
    if (corrections.length > top.length) out.push(`There ${corrections.length - top.length === 1 ? 'is one more correction' : `are ${corrections.length - top.length} more corrections`} written on your screen.`);
    return out;
  }
  return toFix.length ? [`Here is what to fix: ${toFix.slice(0, 3).map((t) => sentence(clip(t, 200))).join(' ')}`] : [];
}

export function loraFinishScript(args: { firstName?: string; title: string; isInternship: boolean }): string {
  const name = args.firstName ? ` ${args.firstName}` : '';
  return args.isInternship
    ? `Congratulations${name}! You've completed the whole internship program. I'm so proud of the work you've done. You can now apply for your internship document from the main screen. Well done!`
    : `Excellent work${name}! You've completed ${args.title}. A new section is now unlocked, whenever you're ready.`;
}
