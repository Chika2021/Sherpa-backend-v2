export interface AiTrainingPlatform {
  id: string;
  name: string;
  url: string;
  /** What contributors typically do there. */
  focus: string[];
}

/**
 * Hand-maintained directory of well-known AI-training / data-work marketplaces.
 * These are NOT live job feeds - most of them have no public API and gate
 * work behind an account + assessment - so the API returns them as
 * "apply here" destinations next to real listings.
 *
 * Eligibility (country, pay, availability of tasks) changes often and varies
 * per platform, so check each site before relying on it.
 */
export const AI_TRAINING_PLATFORMS: AiTrainingPlatform[] = [
  { id: 'micro1', name: 'micro1', url: 'https://www.micro1.ai', focus: ['AI interviewer vetting', 'expert contractors', 'model evaluation'] },
  { id: 'outlier', name: 'Outlier', url: 'https://outlier.ai', focus: ['model evaluation', 'domain experts', 'coding'] },
  { id: 'dataannotation', name: 'DataAnnotation', url: 'https://www.dataannotation.tech', focus: ['chatbot response rating', 'coding', 'writing'] },
  { id: 'mercor', name: 'Mercor', url: 'https://mercor.com', focus: ['expert contractors', 'domain experts', 'coding'] },
  { id: 'alignerr', name: 'Alignerr', url: 'https://www.alignerr.com', focus: ['model evaluation', 'domain experts'] },
  { id: 'invisible', name: 'Invisible Technologies', url: 'https://www.invisible.co', focus: ['expert AI trainers', 'RLHF'] },
  { id: 'turing', name: 'Turing', url: 'https://www.turing.com', focus: ['coding trainers', 'LLM evaluation'] },
  { id: 'appen', name: 'Appen', url: 'https://appen.com', focus: ['data annotation', 'search rating', 'linguists'] },
  { id: 'telus-digital', name: 'TELUS Digital AI Community', url: 'https://www.telusdigital.com', focus: ['data annotation', 'search rating', 'linguists'] },
  { id: 'toloka', name: 'Toloka', url: 'https://toloka.ai', focus: ['microtasks', 'expert annotation'] },
  { id: 'scale', name: 'Scale AI', url: 'https://scale.com', focus: ['data labeling', 'RLHF'] },
];
