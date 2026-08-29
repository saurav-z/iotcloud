import crypto from 'node:crypto';
const key=()=>Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY||'0123456789abcdef0123456789abcdef','utf8').subarray(0,32);
export function encrypt(value:string){const iv=crypto.randomBytes(12);const c=crypto.createCipheriv('aes-256-gcm',key(),iv);const data=Buffer.concat([c.update(value,'utf8'),c.final()]);return [iv.toString('base64url'),c.getAuthTag().toString('base64url'),data.toString('base64url')].join('.');}
export function decrypt(value:string){const [iv,tag,data]=value.split('.');const d=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64url'));d.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([d.update(Buffer.from(data,'base64url')),d.final()]).toString('utf8');}
export function token(prefix:string){return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`}
