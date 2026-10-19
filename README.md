# AUTOSHIFT static site

This folder is the HTML, CSS, and JavaScript version rebuilt from the AUTOSHIFT WordPress export.

## Files

- `index.html` — static page markup, including the new start choices and usage guide
- `assets/css/style.css` — responsive layout and print styles
- `assets/js/app.js` — schedule generation, editing, validation, saving, preview, print, and share behavior
- `assets/img/` — images used by the theme

## Run and deploy

Open `index.html` in a modern browser for a local preview, or upload the **contents of this folder** to a static web host. The WordPress core files in the parent folder are not part of this static build.

The app stores saved settings and schedules in the current browser's `localStorage`. This version does not have a server database or synchronize data between devices or users. Printing uses the browser print dialog; sharing is available after a schedule is confirmed.

## First screen

Visitors can choose to start from a blank setup, load the sample setup, or open a generated sample monthly preview. “操作方法を見る” explains the four main steps.
