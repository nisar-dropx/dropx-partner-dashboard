"use client";
import { useState } from 'react';
import { parsePaymentTrackingIds } from '@/lib/payment-shipment-count';

export function PaymentTrackingInput({ name, required, disabled, defaultValue = '', onValueChange }: { name: string; required: boolean; disabled: boolean; defaultValue?: string; onValueChange?: (value: string) => void }) {
  const [value, setValue] = useState(() => { const initial = parsePaymentTrackingIds(defaultValue); return initial.length ? initial.join('\n') + '\n' : ''; });
  const ids = parsePaymentTrackingIds(value);
  const update = (next: string) => { setValue(next); onValueChange?.(next); };
  return <>
    <textarea className="field" name={name} required={required} disabled={disabled} rows={4} value={value}
      placeholder="Paste tracking IDs or scan here — one ID per line"
      autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onChange={event => update(event.currentTarget.value)}
      onBlur={() => update(ids.length ? ids.join('\n') + '\n' : '')}
      onPaste={event => {
        event.preventDefault();
        const input = event.currentTarget;
        const text = [value.slice(0, input.selectionStart), event.clipboardData.getData('text'), value.slice(input.selectionEnd)].join('\n');
        update(parsePaymentTrackingIds(text).join('\n') + '\n');
      }} />
    <span className="helper-text" aria-live="polite"><strong>{ids.length} unique tracking IDs</strong> · Paste multiple IDs or scan with Enter. Duplicates removed.</span>
  </>;
}
