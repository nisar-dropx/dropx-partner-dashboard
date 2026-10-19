import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, launcher, route] = await Promise.all([
  readFile(new URL("../app/payments/approvals/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("./payment-approval-review-launcher.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/payments/approvals/[requestId]/route.ts", import.meta.url), "utf8")
]);

test("payment approval review opens locally without navigating the server page", () => {
  assert.match(page, /<PaymentApprovalReviewLauncher/);
  assert.doesNotMatch(page, /pendingOverlay={`Opening/);
  assert.doesNotMatch(page, /target="_blank"/);
  assert.match(launcher, /setOpen\(true\)/);
  assert.match(launcher, /createPortal\(modal, document\.body\)/);
});

test("slow evidence is fetched separately from the fast decision shell", () => {
  assert.match(launcher, /fetch\(`\/api\/payments\/approvals\/\$\{encodeURIComponent\(summary\.id\)\}`/);
  assert.match(launcher, /You can approve, return, reject, or open another request now\./);
  assert.match(route, /export async function GET/);
  assert.match(route, /Promise\.all\(\[/);
});

test("attachments use an embedded viewer with an explicit full-size escape hatch", () => {
  assert.match(launcher, /className="payment-attachment-preview-image"/);
  assert.match(launcher, /<iframe className="payment-attachment-preview-frame"/);
  assert.match(launcher, /Preview is not available for this file type\./);
  assert.match(launcher, />Open full size<\/a>/);
  assert.equal((launcher.match(/target="_blank"/g) ?? []).length, 1);
});

test("a decision releases the modal before the backend mutation completes", () => {
  const closeIndex = launcher.indexOf("setOpen(false);", launcher.indexOf("async function decide"));
  const requestIndex = launcher.indexOf("await fetch(", launcher.indexOf("async function decide"));
  assert.ok(closeIndex > -1);
  assert.ok(requestIndex > closeIndex);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /await approvePaymentRequest\(form\)/);
});

test("closing during evidence loading permits a fresh request on reopening", async () => {
  const {default:ts}=await import('typescript');
  const jsx=(type,props)=>({type,props});
  const all=node=>!node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(all)];
  const saved={fetch:globalThis.fetch,document:globalThis.document};
  const slots=[],requests=[];let cursor=0,pending=[];
  const hooks={
    useState(initial){const i=cursor++;slots[i]??={value:initial};return [slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value}]},
    useRef(value){const i=cursor++;slots[i]??={current:value};return slots[i]},
    useMemo(fn){cursor++;return fn()},
    useEffect(fn,deps){const i=cursor++,previous=slots[i];if(!previous||deps.some((value,j)=>value!==previous.deps[j]))pending.push(()=>{previous?.cleanup?.();slots[i]={deps,cleanup:fn()}})}
  };
  globalThis.document={body:{}};
  globalThis.fetch=(url,options)=>new Promise((resolve,reject)=>{requests.push({url,options,resolve});options.signal.addEventListener('abort',()=>reject(new Error('aborted')))});
  const module={exports:{}};
  const mocks={react:hooks,'react-dom':{createPortal:node=>node},'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':{X:'svg',ExternalLink:'svg',Eye:'svg'},'next/navigation':{useRouter:()=>({refresh(){}})}};
  new Function('require','module','exports',ts.transpileModule(launcher,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(id=>mocks[id]??{},module,module.exports);
  const summary={id:'test-request',requestNo:'TEST',locationCode:'ST01',paymentHeadName:'Office supplies',currentStep:1,totalSteps:2,statusLabel:'Pending',amountText:'₹100',paymentMode:null};
  let tree;const render=()=>{cursor=0;pending=[];tree=module.exports.PaymentApprovalReviewLauncher({canAct:false,summary});pending.forEach(fn=>fn());return tree};
  try {
    render();render();all(tree).find(n=>n.type==='button'&&n.props.children==='View').props.onClick();render();
    assert.equal(requests.length,1);
    all(tree).find(n=>n.props['aria-label']==='Close review').props.onClick();render();assert(requests[0].options.signal.aborted);
    all(tree).find(n=>n.type==='button'&&n.props.children==='View').props.onClick();render();assert.equal(requests.length,2);
    requests[1].resolve({ok:true,json:async()=>({answers:[],logs:[],attachmentCount:0})});await new Promise(resolve=>setImmediate(resolve));render();
    assert(!all(tree).some(n=>n.props.className==='payment-review-optional-loading'));
  } finally {slots.forEach(slot=>slot?.cleanup?.());globalThis.fetch=saved.fetch;globalThis.document=saved.document}
});
