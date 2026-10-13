"use client";
import { useEffect, useRef, useState } from 'react';
import styles from './connect-route-fuel.module.css';
type Point=[number,number];
export type RouteGeometry={station:Point;path:Point[];stops:Array<{point:Point;firstScanAt:string;scanCount:number}>};
const TILE=256;
function world(p:Point,z:number){const scale=TILE*2**z,s=Math.sin(Math.max(-85,Math.min(85,p[0]))*Math.PI/180);return {x:(p[1]+180)/360*scale,y:(0.5-Math.log((1+s)/(1-s))/(4*Math.PI))*scale};}
function bounds(points:Point[],z:number){const p=points.map(v=>world(v,z));return {minX:Math.min(...p.map(v=>v.x)),maxX:Math.max(...p.map(v=>v.x)),minY:Math.min(...p.map(v=>v.y)),maxY:Math.max(...p.map(v=>v.y))};}
export function ConnectRouteMap({geometry}:{geometry:RouteGeometry}){
 const wrap=useRef<HTMLDivElement>(null);const [width,setWidth]=useState(800);
 useEffect(()=>{if(!wrap.current)return;const observer=new ResizeObserver(([entry])=>setWidth(Math.max(280,Math.min(1000,entry.contentRect.width))));observer.observe(wrap.current);return()=>observer.disconnect();},[]);
 const W=width,H=width<520?320:460;
 const [offset,setOffset]=useState(0),[pan,setPan]=useState({x:0,y:0}),[selected,setSelected]=useState<number|null>(null);
 const points=geometry.path;let fit=7;
 for(let z=17;z>=4;z--){const b=bounds(points,z);if(b.maxX-b.minX<W-100&&b.maxY-b.minY<H-100){fit=z;break;}}
 const zoom=Math.max(4,Math.min(18,fit+offset)),b=bounds(points,zoom),left=(b.minX+b.maxX-W)/2+pan.x,top=(b.minY+b.maxY-H)/2+pan.y;
 const screen=(p:Point)=>{const v=world(p,zoom);return {x:v.x-left,y:v.y-top};};
 const tiles=[];for(let x=Math.floor(left/TILE);x<=Math.floor((left+W)/TILE);x++)for(let y=Math.floor(top/TILE);y<=Math.floor((top+H)/TILE);y++)if(y>=0&&y<2**zoom)tiles.push({x,y,url:`https://tile.openstreetmap.org/${zoom}/${(x+2**zoom)%2**zoom}/${y}.png`});
 const station=screen(geometry.station),stop=selected===null?null:geometry.stops[selected];
 return <div className={styles.mapWrap} ref={wrap}>
  <div className={styles.mapControls}><span>Numbered stops follow your scan order</span><div><button type="button" aria-label="Zoom in" onClick={()=>{setOffset(v=>v+1);setPan({x:0,y:0});}}>+</button><button type="button" aria-label="Zoom out" onClick={()=>{setOffset(v=>v-1);setPan({x:0,y:0});}}>−</button><button type="button" onClick={()=>{setOffset(0);setPan({x:0,y:0});}}>Fit route</button></div></div>
  <svg viewBox={`0 0 ${W} ${H}`} className={styles.map} aria-label="Your calculated delivery route with numbered stops" onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);(event.currentTarget as SVGSVGElement).dataset.drag=`${event.clientX},${event.clientY},${pan.x},${pan.y}`;}} onPointerMove={event=>{const v=event.currentTarget.dataset.drag?.split(',').map(Number);if(v){const scale=W/event.currentTarget.getBoundingClientRect().width;setPan({x:v[2]-(event.clientX-v[0])*scale,y:v[3]-(event.clientY-v[1])*scale});}}} onPointerUp={event=>{delete event.currentTarget.dataset.drag;}} onPointerCancel={event=>{delete event.currentTarget.dataset.drag;}}>
   <title>Station departure, delivery stops and return</title>
   {tiles.map(tile=><image key={`${zoom}/${tile.x}/${tile.y}`} href={tile.url} x={tile.x*TILE-left} y={tile.y*TILE-top} width={TILE} height={TILE}/>)}
   <polyline points={points.map(p=>{const v=screen(p);return `${v.x},${v.y}`;}).join(' ')} fill="none" stroke="#fff" strokeWidth="8" strokeLinejoin="round"/>
   <polyline points={points.map(p=>{const v=screen(p);return `${v.x},${v.y}`;}).join(' ')} fill="none" stroke="#c23b68" strokeWidth="4" strokeLinejoin="round"/>
   {geometry.stops.map((item,index)=>{const p=screen(item.point);return <g key={index} role="button" tabIndex={0} aria-label={`Stop ${index+1}, ${item.scanCount} scans`} onPointerDown={e=>e.stopPropagation()} onClick={()=>setSelected(index)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(index);}}}><circle cx={p.x} cy={p.y} r={22} fill="transparent"/><circle cx={p.x} cy={p.y} r={selected===index?17:13} fill={selected===index?'#182439':'#fff'} stroke="#c23b68" strokeWidth="2"/><text x={p.x} y={p.y+4} textAnchor="middle" fontSize="11" fontWeight="700" fill={selected===index?'#fff':'#9b244d'}>{index+1}</text></g>;})}
   <circle cx={station.x} cy={station.y} r="17" fill="#15283d" stroke="#fff" strokeWidth="3"/><text x={station.x} y={station.y+5} fill="#fff" textAnchor="middle" fontWeight="700" fontSize="13">S</text>
  </svg>
  <div className={styles.mapFooter}><span><b>S</b> Station · Start &amp; return</span><a href="https://www.mapbox.com/about/maps" target="_blank" rel="noreferrer">Routes © Mapbox</a><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></div>
  {stop?<div className={styles.stopDetail}><strong>Stop {selected!+1}</strong><span>{new Date(stop.firstScanAt).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',minute:'2-digit'})} · {stop.scanCount} scan{stop.scanCount===1?'':'s'}</span><small>Scans at one location are grouped into one stop.</small></div>:<p className={styles.hint}>Tap a numbered stop to see the recorded time and scan count. Drag the map to move it.</p>}
 </div>;
}
