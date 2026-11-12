// Only call this on a WordPress error notice from the explicit Plugins/uploader
// screen. HTTP 403 alone also means an expired nonce or a security challenge.
const known=/not allowed to access this page|not allowed to (?:install|upload|manage|activate) (?:this )?plugins?|недостаточно прав.*(?:плагин|установ|страниц)|не (?:можете|дозволено|маєте права).*(?:плагін|сторінк)|нет прав.*плагин|nicht berechtigt.*plugins|keine berechtigung.*plugins|nie masz uprawnień.*wtycz|no tienes permisos.*plugins|pas l[’']autorisation.*extensions|non.*autorizzat.*plugin|nincs jogosults.*bővítm|nemáte oprávnenie.*(?:modul|plugin)|não.*permissão.*plugin/i;
export function isWordPressPermissionDenial(text){
 if(typeof text!=='string'||!text||text.length>32768)return false;
 const spaced=text.replace(/\s+/gu,' ').trim();if(known.test(spaced))return true;
 const normalized=spaced.normalize('NFKD').replace(/\p{M}/gu,'').replace(/[đĐ]/g,'d').toLowerCase();
 return /\bban khong duoc phep truy cap (?:vao )?trang nay\b/.test(normalized);
}
