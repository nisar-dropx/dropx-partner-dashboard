import styles from "./connect-daily-payment-breakdown.module.css";

export type DailyPaymentProvider = {
  providerMemberId: string;
  providerMemberName: string | null;
  rateLines: Array<{ code: string; label: string; count: number; rate: number; amount: number }>;
};

const money = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const activityOrder = ["delivery", "c_return", "mfn", "mfn_return"];

export function ConnectDailyPaymentBreakdown({ associateName, providers }: { associateName: string; providers: DailyPaymentProvider[] }) {
  return <div className={styles.breakdown}>
    {providers.map((provider) => {
      const byCode = new Map(provider.rateLines.map((line) => [line.code, line]));
      return <section className={styles.provider} key={provider.providerMemberId}>
        <header>
          <span><small>DropX associate</small><strong>{associateName}</strong></span>
          <span><small>Amazon ID</small><strong>{provider.providerMemberId || "—"}</strong></span>
          {provider.providerMemberName ? <span><small>Amazon name</small><strong>{provider.providerMemberName}</strong></span> : null}
        </header>
        <div className={styles.lines}>
          {activityOrder.map((code) => {
            const line = byCode.get(code) ?? { code, label: code === "c_return" ? "C-return" : code === "mfn_return" ? "MFN return" : code === "mfn" ? "MFN" : "Delivery", count: 0, rate: 0, amount: 0 };
            return <div className={styles.line} key={code}>
              <strong>{line.label}</strong>
              <span>{line.count.toLocaleString("en-IN")}</span>
              <b>{money(line.amount)}</b>
            </div>;
          })}
        </div>
      </section>;
    })}
  </div>;
}
