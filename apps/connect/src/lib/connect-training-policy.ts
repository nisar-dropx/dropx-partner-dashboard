export function isPeopleTrainingAccount(account:{workspace?:string;profileType?:string}) {
  // Workforce rollout is deliberately held. Never infer eligibility from a
  // shared mobile, contractor legal type, or client-provided workspace value.
  return account.workspace==='people'&&['employee','contractor'].includes(account.profileType??'');
}
export type TrainingPublicQuestion={id:string;prompt:string;question_type:string;options:string[];points:number};
export function publicTrainingQuestions(value:unknown):TrainingPublicQuestion[]{
 if(!Array.isArray(value))return [];
 return value.map(q=>({id:String(q.id),prompt:String(q.prompt),question_type:String(q.question_type),options:Array.isArray(q.options)?q.options.map(String):[],points:Number(q.points)}));
}
