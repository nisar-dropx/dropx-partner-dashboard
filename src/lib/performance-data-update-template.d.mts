import type {DigestMessage} from './portal-digest-delivery';
export function buildPerformanceDataUpdateMessages(recipients: unknown[],date:string,control:{subject_template:string|null;body_template:string|null;config:Record<string,unknown>}): DigestMessage[];
