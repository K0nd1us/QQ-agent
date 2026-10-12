import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual modal handlers without a browser or third-party DOM dependency.
class Element {
  constructor() { this.dataset = {}; this.style = {}; this.value = ''; this.checked = false; this.children = new Map(); this.events = {}; this.innerHTML = ''; }
  querySelector(sel) { if (!this.children.has(sel)) this.children.set(sel, new Element()); return this.children.get(sel); }
  querySelectorAll(sel) {
    const className = sel.slice(1);
    return [...this.innerHTML.matchAll(/<div\s+([^>]+)>/g)].filter(m => new RegExp(`class="[^\"]*\\b${className}\\b`).test(m[1])).map(m => {
      const el = new Element();
      for (const [, key, value] of m[1].matchAll(/data-([a-z]+)="([^\"]*)"/g)) el.dataset[key] = value;
      return el;
    }).map(el => { this.parsed ||= []; this.parsed.push(el); return el; });
  }
  addEventListener(type, fn) { this.events[type] = fn; }
  async click() { await this.events.click?.(); }
  appendChild(el) { this.children.set('#' + el.id, el); }
}
const code = fs.readFileSync(new URL('../ui/app/08-modals.js', import.meta.url), 'utf8');
const start = code.indexOf('function openModelConfigModal()');
const end = code.indexOf('/** 选择模型：', start);
const providers = [
  { id: 'a', displayName: '渠道 A', baseURL: 'https://a.example/v1', models: ['shared'], modelNames: { shared: 'A 名称' } },
  { id: 'b', displayName: '渠道 B', baseURL: 'https://b.example/v1', models: ['shared'], modelNames: { shared: 'B 名称' } }
];
const shells = [], saved = [];
const sandbox = {
  state: { providers, config: { api: { provider: 'a', model: 'shared', visionModel: 'shared', visionProvider: 'b', videoModel: 'shared', videoProvider: 'a' } } },
  modelModalShell(options) { const el = new Element(); shells.push(el); el.options = options; return el; },
  closeModelModal() {}, loadSettings() {}, esc: x => String(x ?? ''), visionBadge: () => '', alert: message => { throw new Error(message); },
  $: () => new Element(), document: { createElement: () => new Element() }, api: async (url, options) => { saved.push(JSON.parse(options.body)); return {}; }
};
vm.createContext(sandbox); vm.runInContext(code.slice(start, end), sandbox);
sandbox.openModelConfigModal();
const modal = shells[0];
assert.ok(modal.options.body.includes('渠道 B · B 名称'), 'same model id is displayed using its selected provider');
await modal.querySelector('#mc-vision-model-pick').click();
const picker = shells.at(-1);
assert.ok(picker.querySelector('#msp-left').innerHTML.includes('class="mm-prov active" data-pid="b"'));
await picker.querySelector('#msp-right').parsed[0].click();
assert.equal(modal.querySelector('#mc-vision-model-pick').dataset.provider, 'b');
await modal.querySelector('#mc-video-model-pick').click();
const videoPicker = shells.at(-1);
const second = videoPicker.querySelector('#msp-left').parsed.find(el => el.dataset.pid === 'b');
await second.click();
await videoPicker.querySelector('#msp-right').parsed.at(-1).click();
await modal.querySelector('#mc-save').click();
assert.equal(saved.at(-1).api.visionProvider, 'b');
assert.equal(saved.at(-1).api.videoProvider, 'b');
assert.equal(saved.at(-1).api.visionModel, 'shared');
await modal.querySelector('#mc-vision-model-clear').click();
await modal.querySelector('#mc-save').click();
assert.equal(saved.at(-1).api.visionModel, ''); assert.equal(saved.at(-1).api.visionProvider, '');
assert.equal(saved.at(-1).api.videoProvider, 'b', 'clearing images does not clear video provider');
console.log('PASS actual provider/model selection, existing provider label, independent video selection, save and clear handlers');

vm.runInContext(code.slice(code.indexOf('function openModelPicker()'), code.indexOf('function openMemoryModelPicker()')), sandbox);
sandbox.openModelPicker();
const mainPicker = shells.at(-1);
await mainPicker.querySelector('#mm-left').parsed.find(el => el.dataset.pid === 'b').click();
await mainPicker.querySelector('#mm-right').parsed.at(-1).click();
assert.equal(saved.at(-1).api.provider, 'b');
assert.equal(saved.at(-1).api.visionProvider, undefined);
assert.equal(saved.at(-1).api.videoProvider, undefined);
console.log('PASS changing the main provider leaves dedicated image/video selections untouched');
