"use client";
import { EvidencePreview } from './evidence-preview';
import { lossEvidencePreview } from '@/lib/loss-evidence-preview';
export function LossEvidencePreview({href,label,className}:{href:string;label:string;className?:string}) {
  const source=lossEvidencePreview(href);
  return source ? <EvidencePreview {...source} label={label} className={className}/> : <span>File link unavailable</span>;
}
