// Wraps src/dashboard/index.html (page content: title, styles, markup, script) into a full HTML document
// at public/index.html, served next to public/ranking.json (locally, on Cloudflare Pages, or as an Artifact).
import { readFile, writeFile } from "node:fs/promises";

const body = await readFile("src/dashboard/index.html", "utf8");
const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Growth Signals: which companies are building teams now, from job boards, careers pages and news. A case-study prototype for Greenfield Partners.">
<meta name="theme-color" content="#000a1f">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='5' fill='%23000a1f'/%3E%3Cpath d='M6 18V13M10 18V9M14 18V11M18 18V6' stroke='%234a90d9' stroke-width='2.2' stroke-linecap='round'/%3E%3C/svg%3E">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${body}
</body>
</html>
`;
await writeFile("public/index.html", doc);
console.log("wrote public/index.html");
