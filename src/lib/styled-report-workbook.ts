export type ReportCellStyle={bg?:string;color?:string;bold?:boolean;align?:'left'|'right'|'center'};
export type ReportColourRule={column:number;target:number;row?:number};
const colour=(s:string|undefined,fallback:string)=>{
 if(!s) return fallback;
 if(/^#[0-9a-f]{6}$/i.test(s))return 'FF'+s.slice(1).toUpperCase();
 const rgb=s.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
 if(!rgb)return fallback;
 const a=rgb[4]?Number(rgb[4]):1;
 return 'FF'+[1,2,3].map(i=>Math.round(Number(rgb[i])*a+255*(1-a)).toString(16).padStart(2,'0')).join('').toUpperCase();
};
const col=(n:number)=>{let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
/** Add standards-based OpenXML styling; SheetJS community does not write cell styles. */
export async function styleReportWorkbook(bytes:ArrayBuffer|Uint8Array,styles:ReportCellStyle[][]=[],rules:ReportColourRule[]=[],rowCount=0) {
 const {default:JSZip}=await import('jszip');
 const zip=await JSZip.loadAsync(bytes);
 let xml=await zip.file('xl/styles.xml')!.async('string');
 const fontXml:string[]=[],fillXml:string[]=[],xfXml:string[]=[];
 const count=(tag:string)=>Number(xml.match(new RegExp(`<${tag} count="(\\d+)"`))?.[1]||0);
 const fonts=count('fonts'),fills=count('fills'),xfs=count('cellXfs');
 const existingXfs=xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1]||'';
 const percentStyles=new Set([...existingXfs.matchAll(/<xf\b[^>]*(?:\/>|>[\s\S]*?<\/xf>)/g)].flatMap((m,i)=>/numFmtId="10"/.test(m[0])?[i]:[]));
 const cache=new Map<string,number>();
 const style=(s:ReportCellStyle,percent=false)=>{
  const key=JSON.stringify([s,percent]);if(cache.has(key))return cache.get(key)!;
  const fid=fonts+fontXml.length,bid=fills+fillXml.length,id=xfs+xfXml.length;
  fontXml.push(`<font><sz val="10"/><name val="Calibri"/><color rgb="${colour(s.color,'FF172033')}"/>${s.bold?'<b/>':''}</font>`);
  fillXml.push(`<fill><patternFill patternType="solid"><fgColor rgb="${colour(s.bg,'FFFFFFFF')}"/><bgColor indexed="64"/></patternFill></fill>`);
  xfXml.push(`<xf numFmtId="${percent?10:0}" fontId="${fid}" fillId="${bid}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="${s.align||'left'}" vertical="center"/></xf>`);
  cache.set(key,id);return id;
 };
 const sheets=Object.keys(zip.files).filter(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n));
 for(const name of sheets){
  let sheet=await zip.file(name)!.async('string');
  sheet=sheet.replace(/<c\b([^>]*\br="([A-Z]+)(\d+)"[^>]*)>([\s\S]*?)<\/c>/g,(_m,attrs,letters,rowText,body)=>{
   const row=Number(rowText);let column=0;for(const ch of letters)column=column*26+ch.charCodeAt(0)-64;column--;
   const s=row===1?{bg:'#19345b',color:'#ffffff',bold:true}:name==='xl/worksheets/sheet1.xml'?styles[row-2]?.[column]||{}:{};
   const percent=percentStyles.has(Number(attrs.match(/ s="(\d+)"/)?.[1] || 0));
   const id=style(s,percent);
   return `<c${attrs.replace(/ s="\d+"/g,'')} s="${id}">${body}</c>`;
  });
  if(name==='xl/worksheets/sheet1.xml' && rowCount && rules.length){
   const cf=rules.map((r,i)=>{
    const letter=col(r.column),ref=r.row == null ? `${letter}2:${letter}${rowCount+1}` : `${letter}${r.row+2}`;
    return `<conditionalFormatting sqref="${ref}"><cfRule type="cellIs" dxfId="0" priority="${i*3+1}" operator="greaterThanOrEqual" stopIfTrue="1"><formula>${r.target/100}</formula></cfRule><cfRule type="cellIs" dxfId="1" priority="${i*3+2}" operator="greaterThanOrEqual" stopIfTrue="1"><formula>${(r.target-5)/100}</formula></cfRule><cfRule type="cellIs" dxfId="2" priority="${i*3+3}" operator="lessThan"><formula>${(r.target-5)/100}</formula></cfRule></conditionalFormatting>`;
   }).join('');
   sheet=sheet.replace(/(<ignoredErrors|<pageMargins|<pageSetup|<headerFooter|<drawing|<legacyDrawing|<extLst|<\/worksheet>)/,cf+'$1');
  }
  zip.file(name,sheet);
 }
 const append=(tag:string,entries:string[],base:number)=>{xml=xml.replace(new RegExp(`<${tag} count="\\d+"([^>]*)>([\\s\\S]*?)<\\/${tag}>`),`<${tag} count="${base+entries.length}"$1>$2${entries.join('')}</${tag}>`);};
 append('fonts',fontXml,fonts);append('fills',fillXml,fills);append('cellXfs',xfXml,xfs);
 if(rules.length){const dxfs='<dxfs count="3">'+[['166534','DCFCE7'],['92400E','FEF3C7'],['991B1B','FEE2E2']].map(([fg,bg])=>`<dxf><font><color rgb="FF${fg}"/></font><fill><patternFill patternType="solid"><fgColor rgb="FF${bg}"/><bgColor indexed="64"/></patternFill></fill></dxf>`).join('')+'</dxfs>';xml=xml.includes('<dxfs')?xml.replace(/<dxfs[^>]*(?:\/>|>[\s\S]*?<\/dxfs>)/,dxfs):xml.replace('</styleSheet>',dxfs+'</styleSheet>');}
 zip.file('xl/styles.xml',xml);
 return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}
