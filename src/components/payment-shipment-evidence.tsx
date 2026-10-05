"use client";
import { Component, Fragment, useState, type ReactNode } from 'react';
import { shipmentPincodeBreakup, type ShipmentEvidence } from '@/lib/payment-shipment-evidence';
import styles from './payment-shipment-evidence.module.css';

const measure = (value: number | null) => value == null ? '—' : Number(value.toFixed(2)).toLocaleString('en-IN');
const unavailable = 'Shipment details unavailable. You can continue reviewing this request.';
class ShipmentBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="status">{unavailable}</p> : this.props.children; }
}
export function PaymentShipmentEvidence(props: { rows: ShipmentEvidence[]; total: number; divisor: number | null }) {
  return <ShipmentBoundary><ShipmentDetails {...props} /></ShipmentBoundary>;
}
function PackageVisual({ row }: { row: ShipmentEvidence }) {
  const {lengthCm: length, widthCm: width, heightCm: height} = row;
  if (!length || !width || !height) return <p>Package visual unavailable — dimensions missing.</p>;
  const scale = 110 / Math.max(length, width, height);
  const x = length * scale, y = height * scale, d = width * scale * .45;
  return <figure className={styles.visual}>
    <svg viewBox="0 0 250 210" role="img" aria-label={`Illustrative package: length ${length} cm, width ${width} cm, height ${height} cm`}>
      <g transform={`translate(${(250-x-d)/2},${(185-y+d)/2})`} stroke="#19786e" strokeWidth="1.5">
        <path d={`M0 0 L${d} ${-d*.6} L${x+d} ${-d*.6} L${x} 0 Z`} fill="#c7eae4" />
        <path d={`M${x} 0 L${x+d} ${-d*.6} L${x+d} ${y-d*.6} L${x} ${y} Z`} fill="#72b9ae" />
        <rect width={x} height={y} fill="#e4f4f0" />
        <text x={x/2} y={y+19} textAnchor="middle" fill="#24494a" stroke="none" fontSize="12">L {measure(length)} cm</text>
      </g>
      <text x="125" y="198" textAnchor="middle" fill="#526875" fontSize="11">W {measure(width)} cm · H {measure(height)} cm</text>
    </svg>
    <figcaption>Dimension illustration · not a shipment photo. Packaging shape may differ.</figcaption>
  </figure>;
}
function ShipmentDetails({ rows, total, divisor }: { rows: ShipmentEvidence[]; total: number; divisor: number | null }) {
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const filtered = rows.filter(row => `${row.trackingId} ${row.pincode ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const visible = filtered.slice(page * 10, page * 10 + 10);
  const breakup = shipmentPincodeBreakup(rows);
  return <div className={styles.body}>
      <small>{rows.filter(row => row.matched).length} of {total} IDs matched</small>
      {total > rows.length ? <p>Details cover the first {rows.length} of {total} IDs. The complete tracking list remains in Request details.</p> : null}
      <div className={styles.pins} aria-label="Pincode shipment breakup">{breakup.map(item => <span key={item.pincode}><strong>{item.pincode}</strong> {item.count}</span>)}</div>
      <label className={styles.search}>Find tracking ID or pincode<input className="field" value={search} onChange={event => {setSearch(event.currentTarget.value);setPage(0);}} placeholder="Search these shipments" /></label>
      <div className={styles.table}><table><thead><tr><th>Tracking ID</th><th>Pincode</th><th>Weight kg</th><th>L × W × H cm</th><th>Vol. kg</th><th>Approx. fit</th><th>Size visual</th></tr></thead><tbody>{visible.map(row => <Fragment key={row.trackingId}><tr>
        <td><strong>{row.trackingId}</strong>{!row.matched ? <small>Details unavailable</small> : null}</td><td>{row.pincode ?? '—'}</td><td>{measure(row.weightKg)}</td><td>{[row.lengthCm,row.widthCm,row.heightCm].map(measure).join(' × ')}</td><td>{measure(row.volumetricKg)}</td><td>{row.suitability === 'small' ? 'Small / bike' : row.suitability === 'bulky' ? 'Van-needed' : 'Unclassified'}</td><td><button type="button" aria-label={`View size illustration for ${row.trackingId}`} aria-expanded={selected === row.trackingId} onClick={() => setSelected(selected === row.trackingId ? null : row.trackingId)}>{selected === row.trackingId ? 'Close' : 'View size'}</button></td>
      </tr>{selected === row.trackingId ? <tr><td colSpan={7}><div className={styles.selection}><strong>{row.trackingId} · {row.pincode ?? 'Pincode unavailable'}</strong><PackageVisual row={row} /><p>Actual weight {measure(row.weightKg)} kg · Volumetric weight {measure(row.volumetricKg)} kg</p><small>Source snapshot: {row.snapshotAt ? new Date(row.snapshotAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})+' IST' : 'Unavailable'}</small></div></td></tr> : null}</Fragment>)}</tbody></table></div>
      {!visible.length ? <p>No shipments match this search.</p> : null}
      <div className={styles.pages}><span>{filtered.length ? page*10+1 : 0}–{Math.min((page+1)*10,filtered.length)} of {filtered.length}</span><button type="button" disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button><button type="button" disabled={(page+1)*10>=filtered.length} onClick={()=>setPage(page+1)}>Next</button></div>
      <p>Saved shipment evidence only. {divisor ? `Volumetric kg = L × W × H ÷ ${divisor}, using the configured size master.` : 'Volumetric rule unavailable.'} Dimensions and suitability are approximate; missing data does not block approval.</p>
    </div>;
}
