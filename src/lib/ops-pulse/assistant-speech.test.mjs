import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import {readFileSync} from 'node:fs';
import * as language from './assistant-language.ts';
const source=ts.transpileModule(readFileSync(new URL('./assistant-speech.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const module={exports:{}};new Function('require','module','exports',source)(()=>language,module,module.exports);
const {translateAssistantText,generateAssistantSpeech}=module.exports;
test('voice selection never substitutes English for missing Malayalam or Tamil',()=>{
 const voices=[{lang:'en-IN'},{lang:'ta_IN'},{lang:'ml-GB'}];assert.equal(language.matchingAssistantVoice(voices,'ta-IN'),voices[1]);assert.equal(language.matchingAssistantVoice(voices,'ml-IN'),voices[2]);assert.equal(language.matchingAssistantVoice([{lang:'en-IN'}],'ml-IN'),undefined);assert.equal(language.matchingAssistantVoice([{lang:'en-IN'}],'ta-IN'),undefined);
 assert.equal(language.textMatchesLanguage('TCC3 has 3 people on shift','ml-IN'),false);assert.equal(language.textMatchesLanguage('TCC3: ഇന്ന് 3 പേർ ഹാജരായി.','ml-IN'),true);assert.equal(language.assistantLanguage('bad'),'en-IN');
});
test('existing English answers are translated before generating native-script speech',async()=>{
 const old=globalThis.fetch,key=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='test-placeholder';const sent=[];
 const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
 globalThis.fetch=async(url,init)=>{sent.push({url,body:JSON.parse(init.body)});return Response.json(sent.length===1?{candidates:[{content:{parts:[{text:'TCC3: ഇന്ന് 3 പേർ ഹാജരായി.'}]}}]}:{steps:[{type:'model_output',content:[{type:'audio',data:wav.toString('base64')}]}]});};
 try{const translated=await translateAssistantText('TCC3: 3 people present.','ml-IN');await generateAssistantSpeech(translated,'ml-IN');assert.match(sent[0].body.systemInstruction.parts[0].text,/Malayalam/);assert.equal(sent[1].body.input[0].content[0].text,translated);assert.equal(sent[1].body.store,false);assert.equal(sent[1].body.response_format.mime_type,'audio/wav');assert.match(sent[1].body.input[0].content[0].annotations[0].style,/Malayalam/);}
 finally{globalThis.fetch=old;if(key)process.env.GEMINI_API_KEY=key;else delete process.env.GEMINI_API_KEY;}
});
test('English fallback and changed figures are rejected for requested Tamil translation',async()=>{
 const old=globalThis.fetch,key=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='test-placeholder';
 try{for(const text of ['There are 3 people today','இன்று 8 பேர் வந்துள்ளனர்']){globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text}]}}]});await assert.rejects(()=>translateAssistantText('3 people present','ta-IN'));}}
 finally{globalThis.fetch=old;if(key)process.env.GEMINI_API_KEY=key;else delete process.env.GEMINI_API_KEY;}
});
test('already localized Tamil is not translated again',async()=>{
 const text='இன்று 3 பேர் வந்துள்ளனர்';assert.equal(await translateAssistantText(text,'ta-IN'),text);
});
