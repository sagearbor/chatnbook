// Browser entry point for the widget iframe.
//
// app.ts deliberately only *exports* App() without calling it, so the unit
// tests can import it, point globalThis.window/document at a fresh jsdom,
// and mount it under controlled conditions. That means nothing invokes
// App() in a real browser unless a module like this one does -- which is
// exactly the bug this file fixes: app.html used to load app.js directly,
// so the iframe fetched 19KB of module that defined a booking flow and
// then rendered an empty <body>.
//
// Keeping the call here (rather than appending it to app.ts) preserves
// app.ts's side-effect-free import for the tests while giving app.html a
// script whose whole job is to mount the widget. It stays an external file
// rather than an inline <script> so the page needs no 'unsafe-inline' in a
// future Content-Security-Policy.
import { App } from './app.js';

App();
