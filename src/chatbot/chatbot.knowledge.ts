/**
 * Everything the chatbot knows about the app. Edit this file to change its answers.
 *
 * `path` values are the FRONTEND routes the chatbot links to. They are a best guess from the backend
 * modules (the frontend wasn't part of the upload) - change them to match your real routes.
 * `{pricing}` in an answer is replaced with the live token pricing.
 */
export interface KnowledgeTopic {
  id: string;
  title: string;
  keywords: string[];
  answer: string;
  path?: string;
  linkLabel?: string;
}

export const KNOWLEDGE: KnowledgeTopic[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    keywords: ['start', 'begin', 'how does it work', 'what is', 'what can', 'features', 'overview', 'sign up', 'register', 'create account', 'new here'],
    answer:
      'Sherpar helps you land a job: upload your resume, find matching jobs, generate a tailored resume and cover letter for each one, apply (assisted or automatic), and practise interviews. Create a free account to begin - new accounts get free tokens to try the AI features.',
    path: '/register',
    linkLabel: 'Create an account',
  },
  {
    id: 'resume-upload',
    title: 'Upload & parse my resume',
    keywords: ['upload', 'resume', 'cv', 'parse', 'pdf', 'docx', 'import resume', 'my profile'],
    answer:
      'Go to your Resumes page and upload your resume (PDF or Word). The AI reads it and builds your profile, which is then used to match jobs and tailor documents. You can keep several resumes.',
    path: '/resumes',
    linkLabel: 'Open Resumes',
  },
  {
    id: 'resume-builder',
    title: 'Build a resume',
    keywords: ['build resume', 'create resume', 'resume builder', 'make a cv', 'no resume', 'generate resume', 'template'],
    answer:
      "Don't have a resume yet? Use the Resume Builder: fill in your details and a target role and the AI writes a polished resume you can download as a PDF.",
    path: '/resume-builder',
    linkLabel: 'Open Resume Builder',
  },
  {
    id: 'job-search',
    title: 'Find jobs',
    keywords: ['job', 'jobs', 'search', 'find work', 'vacancy', 'vacancies', 'remote', 'internship', 'freelance', 'match', 'listings'],
    answer:
      'Use Jobs to search listings gathered from many job boards (remote, full-time, part-time, freelance, internships and more). Save the ones you like and the AI ranks how well each fits your resume.',
    path: '/jobs',
    linkLabel: 'Search jobs',
  },
  {
    id: 'ai-training-jobs',
    title: 'AI training jobs',
    keywords: ['ai training', 'data annotation', 'annotator', 'rlhf', 'labeling', 'ai tutor', 'train ai'],
    answer:
      'The AI Training Jobs section collects openings from platforms that hire people to train and evaluate AI models. You can browse, filter and save them.',
    path: '/ai-training-jobs',
    linkLabel: 'Browse AI training jobs',
  },
  {
    id: 'apply',
    title: 'Applying to jobs',
    keywords: ['apply', 'application', 'applications', 'submit', 'assisted apply', 'auto apply', 'autoapply', 'cover letter', 'tailor', 'status'],
    answer:
      'For any job you can generate a tailored resume and cover letter. Assisted Apply opens the application form, fills it in for you and waits for you to review and press Submit. Auto-Apply can send several applications in a batch. Track everything under Applications.',
    path: '/applications',
    linkLabel: 'View my applications',
  },
  {
    id: 'interview',
    title: 'Interview practice',
    keywords: ['interview', 'practice', 'mock', 'live interview', 'voice', 'cbt', 'questions', 'prepare', 'preparation'],
    answer:
      'Interview Prep lets you practise with AI-generated questions, multiple-choice (CBT) quizzes, voice answers with feedback, and a live back-and-forth mock interview with a summary at the end.',
    path: '/interview-prep',
    linkLabel: 'Start interview prep',
  },
  {
    id: 'skills',
    title: 'Skill courses',
    keywords: ['skill', 'skills', 'learn', 'course', 'tutorial', 'workshop', 'lab', 'video', 'certificate', 'internship document', 'learning'],
    answer:
      'Skills lets you pick any skill and get a structured tutorial with videos, quizzes, hands-on labs and a guided workshop. You can also unlock a downloadable internship document for a completed course.',
    path: '/skills',
    linkLabel: 'Explore Skills',
  },
  {
    id: 'tokens',
    title: 'Tokens & pricing',
    keywords: ['token', 'tokens', 'price', 'pricing', 'cost', 'how much', 'free', 'credit', 'credits', 'balance', 'buy', 'purchase', 'wallet', 'plan'],
    answer:
      'AI features run on tokens: {pricing} Every new account gets free signup tokens. Your balance and full history are on the Tokens/Wallet page.',
    path: '/tokens',
    linkLabel: 'Open my wallet',
  },
  {
    id: 'payments',
    title: 'Payments & refunds',
    keywords: ['pay', 'payment', 'paystack', 'card', 'charged', 'refund', 'failed payment', 'transaction', 'receipt', 'money', 'deducted', 'debit'],
    answer:
      "Payments are processed securely by Paystack. If a payment went through but tokens didn't arrive, wait a minute and refresh - they are credited automatically. If they're still missing, or you were charged twice, open a support ticket with the payment reference and we'll sort it out.",
    path: '/tokens',
    linkLabel: 'Check my token history',
  },
  {
    id: 'password',
    title: 'Password & login',
    keywords: ['password', 'forgot', 'reset', 'login', 'log in', 'sign in', "can't login", 'cannot login', 'locked', 'change password', 'email not'],
    answer:
      'Forgot your password? Use "Forgot password" on the login page - we email a reset link that is valid for 30 minutes (check spam). When logged in you can change it under Settings > Password.',
    path: '/forgot-password',
    linkLabel: 'Reset my password',
  },
  {
    id: 'credentials',
    title: 'Saved site logins',
    keywords: ['credential', 'credentials', 'site login', 'saved login', 'linkedin login', 'account on site', 'stored password'],
    answer:
      'Some job sites need you to log in before applying. You can save those logins under Credentials; they are stored encrypted and only used to fill applications on your behalf.',
    path: '/credentials',
    linkLabel: 'Manage credentials',
  },
  {
    id: 'profile',
    title: 'Profile settings',
    keywords: ['profile', 'settings', 'name', 'phone', 'location', 'linkedin', 'portfolio', 'account', 'update details'],
    answer: 'You can update your name, phone, location and LinkedIn/portfolio links on your Profile page.',
    path: '/profile',
    linkLabel: 'Open my profile',
  },
  {
    id: 'privacy',
    title: 'Privacy & security',
    keywords: ['privacy', 'secure', 'safe', 'security', 'data', 'delete account', 'gdpr', 'encrypted'],
    answer:
      'Your data is kept private to your account and saved site logins are encrypted. To request deletion of your account or data, open a support ticket and our team will handle it.',
  },
];

export const QUICK_SUGGESTIONS = ['How do I find jobs?', 'How do tokens work?', 'Upload my resume', 'Talk to a human'];
