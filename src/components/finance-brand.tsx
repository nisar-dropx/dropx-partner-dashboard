import Image from "next/image";

export function FinanceProductBrand() {
  return (
    <span className="fin-product-brand" role="img" aria-label="Fin · Finance workspace">
      <Image src="/finance-brand/fin-mark.png" alt="" width={36} height={36} />
      <span><strong>Fin</strong><small>FINANCE</small></span>
    </span>
  );
}

export function FinanceBrand() {
  return (
    <div className="fin-brand">
      <Image className="fin-parent-logo" src="/dropx-logo.png" alt="DropX" width={112} height={54} priority />
      <FinanceProductBrand />
    </div>
  );
}
