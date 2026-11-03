import { Injectable } from '@nestjs/common';
import { ApplicationSubmitter } from './application-submitter.interface';
import { GenericFormAdapter } from './generic-form.adapter';

/**
 * Central place to register application submitters, checked in order.
 * Add ATS-specific adapters here (e.g. a GreenhouseApiAdapter or
 * LeverApiAdapter) if you set up API credentials with those platforms -
 * they'll be more reliable than the generic browser-automation fallback.
 * Consult each ATS's own current developer docs for their apply-submission
 * endpoint and auth model before building one, since these details change
 * and vary per company's board configuration.
 */
@Injectable()
export class SubmitterRegistry {
  private submitters: ApplicationSubmitter[];

  constructor(private genericForm: GenericFormAdapter) {
    this.submitters = [
      // Order matters: more specific/reliable adapters should come first.
      this.genericForm, // catch-all fallback, canHandle() always true
    ];
  }

  resolve(applyUrl: string): ApplicationSubmitter {
    return this.submitters.find((s) => s.canHandle(applyUrl)) || this.genericForm;
  }
}
