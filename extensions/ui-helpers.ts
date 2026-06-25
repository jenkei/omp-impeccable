export const agentCommands = [
  'init',
  'document',
  'craft',
  'shape',
  'critique',
  'audit',
  'polish',
  'bolder',
  'quieter',
  'distill',
  'harden',
  'onboard',
  'animate',
  'colorize',
  'typeset',
  'layout',
  'delight',
  'overdrive',
  'clarify',
  'adapt',
  'optimize',
  'extract',
] as const;

export const extensionCommandDescriptions = new Map<string, string>([
  ['live', 'Start Impeccable live mode in the background'],
  ['status', 'Show Impeccable live server/session status'],
  ['stop', 'Stop Impeccable live mode and polling'],
  ['install', 'Install Impeccable skill files into this project'],
  ['update', 'Update installed Impeccable skill files'],
  ['pin', 'Create an OMP slash-command shortcut for an Impeccable command'],
  ['unpin', 'Remove an OMP slash-command shortcut for an Impeccable command'],
  [
    'hooks',
    'Explain OMP-native live mode; upstream hook manifests are not installed',
  ],
]);

export const fallbackAgentCommandDescriptions = new Map<string, string>([
  [
    'craft',
    'Full confirmed-brief-then-build flow. Runs multi-round shape discovery first, resolves visual probe and north-star mock gates when available, then builds and visually iterates. Use when building a new feature end-to-end.',
  ],
  [
    'init',
    'Sets up a project for Impeccable. Runs a discovery interview when context is missing, writes PRODUCT.md, offers DESIGN.md when code exists, pre-configures live mode, and recommends next commands.',
  ],
  [
    'document',
    'Generate a DESIGN.md file that captures the current visual design system: colors, typography, spacing, radii, and component patterns.',
  ],
  [
    'extract',
    'Pull reusable patterns, components, and design tokens into the design system. Use when drift across the codebase should be consolidated.',
  ],
  [
    'adapt',
    'Adapt designs to work across different screen sizes, devices, contexts, or platforms. Implements breakpoints, fluid layouts, and touch targets.',
  ],
  [
    'animate',
    'Review a feature and enhance it with purposeful animations, micro-interactions, and motion effects that improve usability and delight.',
  ],
  [
    'audit',
    'Run technical quality checks across accessibility, performance, theming, responsive design, and anti-patterns with severity-rated findings.',
  ],
  [
    'bolder',
    'Amplify safe or boring designs to make them more visually interesting and stimulating while maintaining usability.',
  ],
  [
    'clarify',
    'Improve unclear UX copy, error messages, microcopy, labels, and instructions so interfaces are easier to understand.',
  ],
  [
    'colorize',
    'Add strategic color to monochromatic or flat UIs, making interfaces more engaging and expressive.',
  ],
  [
    'critique',
    'Evaluate design from a UX perspective: hierarchy, IA, emotional resonance, cognitive load, scoring, anti-patterns, and actionable feedback.',
  ],
  [
    'delight',
    'Add moments of joy, personality, and unexpected touches that make interfaces memorable and enjoyable to use.',
  ],
  [
    'distill',
    'Strip designs to their essence by removing unnecessary complexity and noise.',
  ],
  [
    'harden',
    'Make interfaces production-ready: error handling, i18n, text overflow, edge cases, and resilience under real-world data.',
  ],
  [
    'onboard',
    'Design onboarding flows, first-run experiences, and empty states that guide new users to value.',
  ],
  [
    'layout',
    'Improve layout, spacing, and visual rhythm. Fix monotonous grids, inconsistent spacing, weak hierarchy, and alignment issues.',
  ],
  [
    'optimize',
    'Diagnose and fix UI performance across loading speed, rendering, animations, images, and bundle size.',
  ],
  [
    'overdrive',
    'Push interfaces past conventional limits with technically ambitious implementations such as shaders, spring physics, and scroll-driven reveals.',
  ],
  [
    'polish',
    'Perform a final quality pass fixing alignment, spacing, consistency, and micro-detail issues before shipping.',
  ],
  [
    'quieter',
    'Tone down visually aggressive or overstimulating designs, reducing intensity while preserving quality.',
  ],
  [
    'shape',
    'Plan UX and UI before code with discovery, visual probes when available, and a user-confirmed design brief.',
  ],
  [
    'typeset',
    'Improve typography by fixing font choices, hierarchy, sizing, weight, and readability so text feels intentional.',
  ],
]);

export function unknownCommandText(command: string) {
  return `Unknown Impeccable command: ${command}. Try /impeccable live.`;
}

export function helpText() {
  return `Usage:
/impeccable <command> [target]
/impeccable install
/impeccable update
/impeccable live [--delivery=steer|followUp]
/impeccable live status
/impeccable live stop
/impeccable pin <upstream-command>
/impeccable unpin <upstream-command>
/impeccable hooks

OMP commands:
live, status, stop, install, update, pin, unpin, hooks

Upstream Impeccable commands:
init, document, shape, craft, critique, audit, polish, bolder, quieter, distill, harden, clarify, onboard, animate, colorize, typeset, layout, delight, overdrive, adapt, optimize, extract

This extension does not vendor Impeccable. It stages the upstream Codex skill, stores the managed copy at .omp/skills/impeccable in your project, then wraps live mode so the poller runs in the background.`;
}
