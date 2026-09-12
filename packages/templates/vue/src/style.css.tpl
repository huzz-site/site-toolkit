:root {
  color: #18202a;
  background: #f4f1ea;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

* {
  box-sizing: border-box;
}

body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
}

#app {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 2rem;
}

main {
  width: min(680px, 100%);
  padding: clamp(2rem, 7vw, 5rem);
  border: 1px solid rgb(24 32 42 / 12%);
  border-radius: 2rem;
  background: rgb(255 255 255 / 62%);
  box-shadow: 0 30px 90px rgb(39 45 51 / 10%);
}

.eyebrow {
  margin: 0 0 1rem;
  color: #bb4d2f;
  font-size: 0.75rem;
  font-weight: 750;
  letter-spacing: 0.18em;
}

h1 {
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(3rem, 11vw, 7rem);
  font-weight: 500;
  line-height: 0.95;
}

.lead {
  max-width: 32rem;
  margin: 2rem 0;
  color: #52606d;
  font-size: 1.1rem;
  line-height: 1.7;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 0.65rem;
  color: #52606d;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}

.status span {
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 50%;
  background: #d09532;
}

.status[data-state="ready"] span {
  background: #27835f;
}

.status[data-state="unavailable"] span {
  background: #b43b35;
}
