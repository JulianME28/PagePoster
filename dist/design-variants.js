(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PagePosterDesignVariants=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var VERSION=1,fonts=['Arial','Georgia','Verdana','Trebuchet MS','system-ui'];
  var palettes=[
    {preset:'emerald',colors:{background:'#f6feff',accent:'#b52c17',header:'#080220',card:'#0c6c4b'}},
    {preset:'forest',colors:{background:'#faf8fc',accent:'#b52c17',header:'#082c00',card:'#116b3a'}},
    {preset:'rose',colors:{background:'#fbf9f8',accent:'#fa78b9',header:'#171717',card:'#293f2d'}},
    {preset:'emerald',colors:{background:'#f2f6ff',accent:'#1746a2',header:'#111d3c',card:'#163f74'}},
    {preset:'forest',colors:{background:'#fff9ef',accent:'#8a3517',header:'#2f2115',card:'#5c4126'}},
    {preset:'rose',colors:{background:'#f8f3ff',accent:'#d8b6ff',header:'#28133e',card:'#4a275e'}}
  ];
  function clone(value){return JSON.parse(JSON.stringify(value));}
  function hash(value){var h=2166136261;for(var i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
  function luminance(hex){var parts=[1,3,5].map(function(i){var n=parseInt(hex.slice(i,i+2),16)/255;return n<=.04045?n/12.92:Math.pow((n+.055)/1.055,2.4);});return parts[0]*.2126+parts[1]*.7152+parts[2]*.0722;}
  function contrast(background){var light=luminance(background),foreground=light>.179?'#111a16':'#ffffff',dark=luminance(foreground);return {background:background,foreground:foreground,ratio:(Math.max(light,dark)+.05)/(Math.min(light,dark)+.05)};}
  function select(seed,sequence){
    if(!['string','number'].includes(typeof seed)||!String(seed).length||String(seed).length>200||(typeof seed==='number'&&!Number.isFinite(seed)))throw Error('Потрібен скінченний seed або короткий рядок.');
    if(sequence===undefined)sequence=0;if(!Number.isSafeInteger(sequence)||sequence<0)throw Error('Порядковий номер має бути невід’ємним цілим числом.');
    seed=String(seed);var h=hash(seed),index=(h%palettes.length+sequence%palettes.length)%palettes.length,palette=palettes[index];
    var variant={version:VERSION,seed:seed,sequence:sequence,paletteId:'palette-'+index,preset:palette.preset,fontFamily:fonts[(Math.floor(h/palettes.length)+sequence)%fonts.length],colors:clone(palette.colors),contrast:{}};
    Object.keys(variant.colors).forEach(function(key){var report=contrast(variant.colors[key]);if(report.ratio<4.5)throw Error('Недостатній контраст палітри.');variant.contrast[key]=report;});return variant;
  }
  function apply(config,options){if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Потрібна конфігурація сторінки.');var next=clone(config);if(config.contentMode==='html')return {applied:false,nextConfig:next,variant:null,reason:'Оформлення вставленого HTML збережено.'};options=options||{};var variant=select(options.seed,options.sequence);next.preset=variant.preset;next.colors=clone(variant.colors);next.fontFamily=variant.fontFamily;next.designVariant=clone(variant);return {applied:true,nextConfig:next,variant:variant};}
  return {select:select,apply:apply,version:VERSION};
});
