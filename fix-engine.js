const fs = require('fs');
const file = 'src/orchestration/engine.js';
let code = fs.readFileSync(file, 'utf8');
const find = "if (candidate.length >= 3 && !/^(that|this|it|there|here|same|different|the|a|an)$/i.test(candidate) && !parseDateExpression(candidate)) {";
const replace = "const TRANSPORT_WORDS = new Set(['flight','flights','fly','flying','train','sgr','madaraka','bus','buses','coach','ferry','drive','car']);\n            if (TRANSPORT_WORDS.has(candidate.toLowerCase())) break;\n            if (candidate.length >= 3 && !/^(that|this|it|there|here|same|different|the|a|an|flight|flights|train|sgr|madaraka|bus|fly)$/i.test(candidate) && !parseDateExpression(candidate)) {";
if (!code.includes(find)) { console.log('ERROR: string not found'); process.exit(1); }
code = code.replace(find, replace);
fs.writeFileSync(file, code, 'utf8');
console.log('Done');
