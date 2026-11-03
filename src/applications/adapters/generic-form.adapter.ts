import { Injectable, Logger } from '@nestjs/common';
import { chromium, Page, Frame } from 'playwright';
import {
  ApplicationSubmitter,
  SiteCredentials,
  SubmissionDocuments,
  SubmissionProfile,
  SubmissionResult,
} from './application-submitter.interface';

/**
 * Best-effort, heuristic form-filler that works against most standard job
 * application pages (Greenhouse, Lever, Workable, and plenty of bespoke career
 * sites use fairly conventional field labels/names). It:
 *   1. If a stored SiteCredential matches the apply URL's domain, attempts to
 *      sign in first (see handleAuthentication) - either via an explicit
 *      login page or by detecting a login wall on the apply page itself. If
 *      that credential is also marked autoSignupIfMissing and login fails, it
 *      makes one best-effort attempt to create an account instead.
 *   2. Opens the apply page in a headless browser.
 *   3. Looks for common field patterns (by label text, placeholder, name, id,
 *      and aria-label) for name, email, phone, LinkedIn/portfolio URL, resume
 *      upload, and cover letter.
 *   4. Fills whatever it confidently finds and uploads the resume/cover letter
 *      files to any file input it can identify.
 *   5. Only clicks the submit button if it filled ALL fields it considers
 *      required (name, email, resume upload). Otherwise it stops short and
 *      reports MANUAL_REVIEW with exactly what it did and didn't find, so the
 *      candidate can finish the last step themselves in under a minute.
 *
 * This intentionally will NOT succeed on every site - CAPTCHAs, multi-step
 * wizards, 2FA, and heavily custom React forms with no accessible labels all
 * fall back to MANUAL_REVIEW, as does any signup attempt (nearly every site
 * requires email verification, which nothing here can complete). That's by
 * design: a silent wrong submission - or a bot account left half-created - is
 * worse than asking the user to double check.
 */
@Injectable()
export class GenericFormAdapter implements ApplicationSubmitter {
  name = 'generic-form';
  private readonly logger = new Logger(GenericFormAdapter.name);

  canHandle(_applyUrl: string): boolean {
    // Registered as the catch-all fallback - see ApplicationSubmitterRegistry.
    return true;
  }

  async submit(
    applyUrl: string,
    profile: SubmissionProfile,
    documents: SubmissionDocuments,
    credentials?: SiteCredentials | null,
  ): Promise<SubmissionResult> {
    const browser = await chromium.launch({ headless: true });
    const filled: string[] = [];
    const missing: string[] = [];

    try {
      const page = await browser.newPage();
      const opened = await this.openApplyPage(
        page,
        applyUrl,
        profile,
        credentials,
        documents.resumePath.replace(/\.[^.]+$/, ''),
      );
      if (!opened.ok) return opened.result;
      const targetFrame = opened.frame;

      const tryFill = async (patterns: RegExp[], value?: string, fieldName = '') => {
        if (!value) {
          missing.push(fieldName);
          return false;
        }
        for (const pattern of patterns) {
          const token = this.regexToToken(pattern);
          if (!token) continue;
          const selector = [
            `input[name*="${token}" i]`,
            `input[id*="${token}" i]`,
            `input[placeholder*="${token}" i]`,
            `input[aria-label*="${token}" i]`,
            `textarea[name*="${token}" i]`,
            `textarea[id*="${token}" i]`,
          ].join(', ');
          try {
            const locator = targetFrame.locator(selector).first();
            if (await locator.count()) {
              await locator.fill(value, { timeout: 3000 });
              filled.push(fieldName);
              return true;
            }
          } catch {
            /* try next pattern */
          }
        }
        // Fallback: search by nearby <label> text
        try {
          const byLabel = targetFrame.getByLabel(patterns[0], { exact: false }).first();
          if (await byLabel.count()) {
            await byLabel.fill(value, { timeout: 3000 });
            filled.push(fieldName);
            return true;
          }
        } catch {
          /* no match */
        }
        missing.push(fieldName);
        return false;
      };

      await tryFill([/full.?name/i, /^name$/i, /your name/i], profile.fullName, 'fullName');
      await tryFill([/e-?mail/i], profile.email, 'email');
      await tryFill([/phone/i], profile.phone, 'phone');
      await tryFill([/linkedin/i], profile.linkedinUrl, 'linkedinUrl');
      await tryFill([/portfolio|website/i], profile.portfolioUrl, 'portfolioUrl');
      await tryFill(
        [/cover.?letter|why (do you|are you)|additional info/i],
        undefined, // cover letter is a file upload in most ATSs, handled below as text fallback
        'coverLetterText',
      );

      // Resume upload
      let resumeUploaded = false;
      try {
        const fileInputs = targetFrame.locator('input[type="file"]');
        const count = await fileInputs.count();
        for (let i = 0; i < count; i++) {
          const input = fileInputs.nth(i);
          const attrs = ((await input.getAttribute('name')) || '') +
            ((await input.getAttribute('id')) || '') +
            ((await input.getAttribute('aria-label')) || '');
          if (/resume|cv/i.test(attrs) || count === 1) {
            await input.setInputFiles(documents.resumePath);
            resumeUploaded = true;
            filled.push('resume');
          } else if (/cover/i.test(attrs) && documents.coverLetterPath) {
            await input.setInputFiles(documents.coverLetterPath);
            filled.push('coverLetter');
          }
        }
      } catch (err) {
        this.logger.warn(`Resume upload attempt failed for ${applyUrl}: ${err}`);
      }
      if (!resumeUploaded) missing.push('resume');

      const screenshotPath = documents.resumePath.replace(/\.[^.]+$/, '') + '-preview.png';
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);

      const requiredOk =
        filled.includes('fullName') && filled.includes('email') && filled.includes('resume');

      if (!requiredOk) {
        return {
          outcome: 'MANUAL_REVIEW',
          message:
            'Attempted this in the background but could not confidently complete all required fields. ' +
            'Open the original posting and finish it yourself - the generated resume and cover letter are ready to use.',
          fieldsFilled: filled,
          fieldsMissing: missing,
          screenshotPath,
        };
      }

      // Try to find and click a submit button, but stay conservative.
      const submitButton = targetFrame
        .getByRole('button', { name: /submit|apply|send application/i })
        .first();

      if (!(await submitButton.count())) {
        return {
          outcome: 'MANUAL_REVIEW',
          message:
            'All key fields were filled during a background attempt, but no clear submit button was found. ' +
            'Open the original posting to review and submit it yourself.',
          fieldsFilled: filled,
          fieldsMissing: missing,
          screenshotPath,
        };
      }

      await submitButton.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(2000);

      return {
        outcome: 'SUBMITTED',
        message: 'Application form filled and submitted automatically.',
        fieldsFilled: filled,
        fieldsMissing: missing,
        screenshotPath,
      };
    } catch (err) {
      this.logger.error(`Auto-apply failed for ${applyUrl}: ${err}`);
      return {
        outcome: 'MANUAL_REVIEW',
        message: `Automation hit an unexpected error (${(err as Error).message}). Please apply manually - the generated resume and cover letter are ready to use.`,
        fieldsFilled: filled,
        fieldsMissing: missing,
      };
    } finally {
      await browser.close();
    }
  }

  /**
   * Everything that has to happen before any field can be filled: sign in if
   * we hold credentials for the site, navigate to the apply URL, wait for the
   * (often client-rendered) form to appear, and work out which frame actually
   * holds it. Shared by the one-shot `submit()` above and the assisted
   * (fill-then-let-the-user-submit) flow, so both behave identically up to
   * this point. Returns the frame to work in, or - when the page can't be
   * used (login wall, no form, CAPTCHA on login) - a ready-made
   * MANUAL_REVIEW result explaining why.
   *
   * `screenshotBase` is a path prefix (no extension); a "-preview.png" is
   * written next to it when the page has no form on it.
   */
  async openApplyPage(
    page: Page,
    applyUrl: string,
    profile: SubmissionProfile,
    credentials: SiteCredentials | null | undefined,
    screenshotBase: string,
  ): Promise<{ ok: true; frame: Frame } | { ok: false; result: SubmissionResult }> {
    // If we know up front that this site needs a session before the apply
    // page is even reachable (an explicit loginUrl was configured for it),
    // sign in first.
    if (credentials?.loginUrl) {
      const authOutcome = await this.handleAuthentication(page, credentials, profile, credentials.loginUrl);
      if (authOutcome) return { ok: false, result: authOutcome };
    }

    await this.gotoWithRetry(page, applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Most real ATS forms (Greenhouse, Lever, Workday, bespoke React/Vue
    // career pages) render their actual form fields client-side, after
    // domcontentloaded fires. Scanning immediately would find an empty
    // shell and report every field as missing. Give the page a chance to
    // go network-idle, then explicitly wait for *something* form-like to
    // exist before we start looking for specific fields.
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await page
      .waitForSelector('form, input, textarea', { state: 'attached', timeout: 15000 })
      .catch(() => undefined);
    // Some ATS widgets (Comeet, Greenhouse embeds, etc.) render inside an
    // iframe and take a beat longer than the host page to paint their
    // fields in - give that a moment before we go looking for them.
    await page.waitForTimeout(1500);

    // We weren't told this site needs a login up front, but plenty of
    // portals (Workday and various in-house ones) redirect an unauthenticated
    // visitor straight to a sign-in page instead of the form. If we have
    // credentials for this domain and the page we actually landed on looks
    // like a login wall, try signing in right here and then reload the
    // apply page.
    if (credentials && !credentials.loginUrl) {
      const looksLikeLoginWall = (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
      if (looksLikeLoginWall) {
        const authOutcome = await this.handleAuthentication(page, credentials, profile);
        if (authOutcome) return { ok: false, result: authOutcome };
        await this.gotoWithRetry(page, applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
        await page.waitForTimeout(1500);
      }
    }

    // The real form often isn't on the top-level page at all - plenty of
    // ATS platforms (Comeet, Greenhouse, Lever) embed their widget in an
    // iframe on the company's own site. Instead of assuming it's always
    // the main frame, check every frame and use whichever one actually
    // has the most form fields.
    const frameCandidates = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
    let targetFrame = page.mainFrame();
    let formFieldCount = 0;
    for (const frame of frameCandidates) {
      try {
        const count = await frame.locator('input, textarea, select').count();
        if (count > formFieldCount) {
          formFieldCount = count;
          targetFrame = frame;
        }
      } catch {
        // Cross-origin frame not ready yet, or it navigated away mid-check - skip it.
      }
    }

    if (formFieldCount === 0) {
      // Distinguish "this link doesn't actually lead to an application
      // form" from a plain fill failure - a very different problem to
      // report, since no amount of better selectors will fix a job-board
      // listing page or a page that requires a login first.
      const screenshotPath = screenshotBase + '-preview.png';
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      return {
        ok: false,
        result: {
          outcome: 'MANUAL_REVIEW',
          message:
            `This page (${page.url()}) doesn't appear to have an application form on it - it may be a ` +
            'listing page rather than the apply form, require sign-in first, or need more time to load. ' +
            'Please open the link and apply manually.',
          fieldsFilled: [],
          fieldsMissing: ['fullName', 'email', 'phone', 'linkedinUrl', 'portfolioUrl', 'coverLetterText', 'resume'],
          screenshotPath,
        },
      };
    }

    return { ok: true, frame: targetFrame };
  }

  private regexToToken(pattern: RegExp): string {
    // CSS attribute selectors need a plain substring, not a regex - this pulls
    // the first alphabetic token out of the pattern as a best-effort match
    // (e.g. /e-?mail/i -> "mail", /full.?name/i -> "full").
    const cleaned = pattern.source.replace(/[^a-zA-Z]+/g, ' ').trim();
    return cleaned.split(' ')[0] || '';
  }

  /**
   * Shared field-filling heuristic (by name/id/placeholder/aria-label, then
   * by nearby <label> text) used for login and signup forms. The main
   * apply-form filler above keeps its own `tryFill` because it also tracks
   * which fields were filled/missing for the returned SubmissionResult -
   * this one just needs a plain yes/no.
   */
  private async fillFirstMatch(frame: Frame, patterns: RegExp[], value?: string): Promise<boolean> {
    if (!value) return false;
    for (const pattern of patterns) {
      const token = this.regexToToken(pattern);
      if (!token) continue;
      const selector = [
        `input[name*="${token}" i]`,
        `input[id*="${token}" i]`,
        `input[placeholder*="${token}" i]`,
        `input[aria-label*="${token}" i]`,
      ].join(', ');
      try {
        const locator = frame.locator(selector).first();
        if (await locator.count()) {
          await locator.fill(value, { timeout: 3000 });
          return true;
        }
      } catch {
        /* try next pattern */
      }
    }
    try {
      const byLabel = frame.getByLabel(patterns[0], { exact: false }).first();
      if (await byLabel.count()) {
        await byLabel.fill(value, { timeout: 3000 });
        return true;
      }
    } catch {
      /* no match */
    }
    return false;
  }

  /**
   * Detects a CAPTCHA/bot-challenge widget on the current frame. There is no
   * way to automate past one of these - the only honest move is to stop and
   * hand it back to the human.
   */
  async pageHasCaptcha(frame: Frame): Promise<boolean> {
    try {
      const selectors = [
        'iframe[src*="recaptcha" i]',
        'iframe[src*="hcaptcha" i]',
        'iframe[title*="captcha" i]',
        '[class*="cf-turnstile" i]',
        '#challenge-form',
        'text=/verify you are human/i',
      ].join(', ');
      return (await frame.locator(selectors).count()) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Attempts to sign in on the current page (if loginUrl is omitted) or after
   * navigating to loginUrl. Returns { ok: true } on apparent success,
   * { ok: false, message: 'captcha' } if a CAPTCHA blocked it, or
   * { ok: false, message } with a human-readable reason otherwise.
   */
  private async attemptLogin(
    page: Page,
    loginUrl: string | undefined,
    credentials: SiteCredentials,
  ): Promise<{ ok: boolean; message?: string }> {
    if (loginUrl) {
      try {
        await this.gotoWithRetry(page, loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (err) {
        return { ok: false, message: `Could not reach the login page (${(err as Error).message}).` };
      }
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
      await page.waitForTimeout(1000);
    }

    const frame = page.mainFrame();

    if (await this.pageHasCaptcha(frame)) {
      return { ok: false, message: 'captcha' };
    }

    const emailFilled = await this.fillFirstMatch(
      frame,
      [/e-?mail/i, /username/i, /^user(name)?$/i],
      credentials.username,
    );
    const passwordLocator = frame.locator('input[type="password"]').first();
    let passwordFilled = false;
    if (await passwordLocator.count().catch(() => 0)) {
      try {
        await passwordLocator.fill(credentials.password, { timeout: 3000 });
        passwordFilled = true;
      } catch {
        /* handled by the check below */
      }
    }

    if (!emailFilled || !passwordFilled) {
      return { ok: false, message: 'No recognizable login form (email/username + password fields) was found on this page.' };
    }

    const submitButton = frame.getByRole('button', { name: /log ?in|sign ?in|continue/i }).first();
    if (await submitButton.count()) {
      await submitButton.click({ timeout: 5000 }).catch(() => undefined);
    } else {
      await passwordLocator.press('Enter').catch(() => undefined);
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1000);

    const errorVisible = await frame
      .locator('text=/incorrect|invalid (email|username|password|credentials)|doesn.?t match|wrong password/i')
      .count()
      .catch(() => 0);
    if (errorVisible > 0) {
      return { ok: false, message: 'The site rejected the stored credentials (incorrect email or password).' };
    }

    const stillHasPasswordField = await frame.locator('input[type="password"]').count().catch(() => 0);
    if (stillHasPasswordField > 0) {
      return { ok: false, message: "Could not confirm the login went through - a password field is still showing." };
    }

    return { ok: true };
  }

  /**
   * Best-effort account creation. This is inherently less reliable than
   * login: most sites require email verification (sometimes phone/SMS)
   * before the new account is actually usable, which nothing here can
   * complete. Success just means "the signup form was submitted without an
   * obvious error" - the caller always reports this back as MANUAL_REVIEW
   * with a note to check the inbox and verify, never as SUBMITTED.
   */
  private async attemptSignup(
    page: Page,
    signupUrl: string,
    credentials: SiteCredentials,
    profile: SubmissionProfile,
  ): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.gotoWithRetry(page, signupUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (err) {
      return { ok: false, message: `Could not reach the signup page (${(err as Error).message}).` };
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1000);

    const frame = page.mainFrame();

    if (await this.pageHasCaptcha(frame)) {
      return { ok: false, message: 'captcha' };
    }

    await this.fillFirstMatch(frame, [/full.?name/i, /^name$/i], profile.fullName);
    const emailFilled = await this.fillFirstMatch(frame, [/e-?mail/i], credentials.username);

    // Signup forms commonly have two password inputs (password + confirm) -
    // fill every password-type field with the same value to cover both.
    const passwordFields = frame.locator('input[type="password"]');
    const passwordCount = await passwordFields.count().catch(() => 0);
    let passwordFilled = false;
    for (let i = 0; i < passwordCount; i++) {
      try {
        await passwordFields.nth(i).fill(credentials.password, { timeout: 3000 });
        passwordFilled = true;
      } catch {
        /* skip this field */
      }
    }

    if (!emailFilled || !passwordFilled) {
      return { ok: false, message: 'No recognizable signup form (email + password fields) was found on this page.' };
    }

    const submitButton = frame.getByRole('button', { name: /sign ?up|create account|register|get started/i }).first();
    if (await submitButton.count()) {
      await submitButton.click({ timeout: 5000 }).catch(() => undefined);
    } else {
      await passwordFields.first().press('Enter').catch(() => undefined);
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1500);

    const errorVisible = await frame
      .locator('text=/already (registered|exists|in use)|invalid email|password (is too weak|must)/i')
      .count()
      .catch(() => 0);
    if (errorVisible > 0) {
      return {
        ok: false,
        message: "The site rejected the signup attempt (an account may already exist, or the password didn't meet its requirements).",
      };
    }

    return {
      ok: true,
      message:
        `A new account for ${credentials.username} may have been created on this site, but most sites require ` +
        'verifying the email address before it actually works. Check that inbox for a verification link/code, ' +
        'confirm it, and then re-run Apply.',
    };
  }

  /**
   * Orchestrates the login -> (optional) signup fallback flow and turns the
   * outcome into a SubmissionResult when authentication doesn't end in a
   * usable, signed-in session. Returns null when login succeeded and the
   * caller should carry on filling out the actual application form.
   */
  private async handleAuthentication(
    page: Page,
    credentials: SiteCredentials,
    profile: SubmissionProfile,
    loginUrl?: string,
  ): Promise<SubmissionResult | null> {
    const loginResult = await this.attemptLogin(page, loginUrl, credentials);
    if (loginResult.ok) return null;

    if (loginResult.message === 'captcha') {
      return {
        outcome: 'MANUAL_REVIEW',
        message:
          "Signing in to this site requires solving a CAPTCHA, which can't be automated. Please log in manually " +
          'once, then re-run Apply - the generated resume and cover letter are ready to use.',
        fieldsFilled: [],
        fieldsMissing: [],
      };
    }

    if (credentials.autoSignupIfMissing && credentials.signupUrl) {
      const signupResult = await this.attemptSignup(page, credentials.signupUrl, credentials, profile);

      if (signupResult.message === 'captcha') {
        return {
          outcome: 'MANUAL_REVIEW',
          message:
            "Creating an account on this site requires solving a CAPTCHA, which can't be automated. Please sign " +
            'up manually, then re-run Apply.',
          fieldsFilled: [],
          fieldsMissing: [],
        };
      }

      if (!signupResult.ok) {
        return {
          outcome: 'MANUAL_REVIEW',
          message:
            `Could not sign in (${loginResult.message}), and an automated signup attempt didn't succeed either ` +
            `(${signupResult.message}). Please create an account manually - the generated resume and cover ` +
            'letter are ready to use.',
          fieldsFilled: [],
          fieldsMissing: [],
        };
      }

      // The signup form was submitted, but this is never treated as a
      // completed application - see attemptSignup's docstring.
      return {
        outcome: 'MANUAL_REVIEW',
        message: signupResult.message!,
        fieldsFilled: [],
        fieldsMissing: [],
      };
    }

    return {
      outcome: 'MANUAL_REVIEW',
      message:
        `Could not sign in with the saved credentials for this site: ${loginResult.message}. Please log in ` +
        'manually, then finish the application yourself - the generated resume and cover letter are ready to use.',
      fieldsFilled: [],
      fieldsMissing: [],
    };
  }

  /**
   * page.goto against a real-world career site occasionally fails with a
   * transient connection error (ERR_CONNECTION_RESET, ERR_CONNECTION_REFUSED,
   * ERR_NETWORK_CHANGED, ERR_CONNECTION_TIMED_OUT) or simply times out because
   * the page took too long to respond (Playwright's own "Timeout Xms
   * exceeded") - neither has anything to do with the page's content, and both
   * are common against slow-loading or bot-wary career sites. A couple of
   * retries with backoff resolves most of these without masking a genuinely
   * dead/invalid URL, which will just fail the same way every time and fall
   * through to the caller's error handling as before.
   */
  private async gotoWithRetry(
    page: Page,
    url: string,
    options: { waitUntil: 'domcontentloaded'; timeout: number },
    attempts = 3,
  ): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await page.goto(url, options);
        return;
      } catch (err) {
        const message = (err as Error)?.message || '';
        const isRetryable =
          /ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_NETWORK_CHANGED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED/i.test(
            message,
          ) || /Timeout\s+\d+ms\s+exceeded/i.test(message);
        if (!isRetryable || attempt === attempts) throw err;
        this.logger.warn(
          `page.goto to ${url} failed (${message}), retrying [attempt ${attempt}/${attempts}]`,
        );
        await page.waitForTimeout(2000 * attempt);
      }
    }
  }
}