export const root=(projectId:string)=>`iotcloud/${projectId}`;
export function deviceTopic(projectId:string,deviceId:string,topic:string){return `${root(projectId)}/${deviceId}/${topic.replace(/^\/+/, '')}`}
export function parseTopic(topic:string){const p=topic.split('/');if(p.length<4||p[0]!=='iotcloud')return null;return {projectId:p[1],deviceId:p[2],topic:p.slice(3).join('/')};}
export function allowedTopic(topic:string,projectId:string,deviceId:string){const x=parseTopic(topic);return !!x&&x.projectId===projectId&&x.deviceId===deviceId;}
