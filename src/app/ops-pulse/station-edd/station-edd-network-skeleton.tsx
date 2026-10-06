import s from "./station-edd.module.css";

/** Shown while the station list and cached counts stream in, so the tab opens at once. */
export function StationEddNetworkSkeleton() {
  return <div className={s.workspace} role="status" aria-label="Loading EDD counts">
    <div className={s.contextBar}><span className={s.skeleton} style={{ width: 220 }}/><span className={s.skeleton} style={{ width: 160 }}/></div>
    <section className={s.metrics}>
      {Array.from({ length: 6 }, (_, index) => <div key={index} className={s.metric}><span className={s.skeleton} style={{ width: "55%" }}/><strong className={s.skeleton} style={{ width: "40%", height: 32 }}/><small className={s.skeleton} style={{ width: "75%" }}/></div>)}
    </section>
    <section className={s.panel}>
      <div className={s.panelHead}><div><span className={s.eyebrow}>STATION OVERVIEW</span><h2>Loading stations…</h2><p>Counts appear here as soon as they are ready.</p></div></div>
      <div className={s.skeletonRows}>{Array.from({ length: 8 }, (_, index) => <span key={index} className={s.skeleton}/>)}</div>
    </section>
  </div>;
}
