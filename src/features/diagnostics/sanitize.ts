const sensitiveKey=/password|passwd|secret|token|sessionid|authorization|certificatepem/i;
const sensitiveText=/(password|passwd|secret|token|sessionId)\s*[=:]\s*[^\s,;]+/gi;

export const sanitizeDiagnostics=(value:unknown):unknown=>{
  if(typeof value==='string')return value.replace(sensitiveText,'$1=[REDACTED]');
  if(Array.isArray(value))return value.map(sanitizeDiagnostics);
  if(value&&typeof value==='object'){
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[
      key,sensitiveKey.test(key)?'[REDACTED]':sanitizeDiagnostics(item),
    ]));
  }
  return value;
};
