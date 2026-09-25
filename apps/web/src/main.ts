import './style.css';
import { App } from './app.js';
import { publish } from './hook.js';

const root = document.getElementById('app');
if (!root) throw new Error('#app root element missing');

try {
  const app = new App(root);
  void app.start(new URLSearchParams(window.location.search));
} catch (err) {
  // e.g. WebGL unavailable: surface it instead of leaving a blank page.
  const message = err instanceof Error ? err.message : String(err);
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'fatal';
  box.textContent = `polymerge viewer failed to start: ${message}`;
  root.append(box);
  publish({ state: 'error', error: message });
  console.error(err);
}
