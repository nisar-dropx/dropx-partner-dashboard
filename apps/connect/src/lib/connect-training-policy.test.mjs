import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPeopleTrainingAccount,publicTrainingQuestions} from './connect-training-policy.ts';
test('only People employees and People contractors receive Training',()=>{
 for(const profileType of ['employee','contractor'])assert.equal(isPeopleTrainingAccount({workspace:'people',profileType}),true);
 for(const profileType of ['employee','contractor','workforce','user'])assert.equal(isPeopleTrainingAccount({workspace:'workforce',profileType}),false);
 assert.equal(isPeopleTrainingAccount({workspace:'people',profileType:'user'}),false);
 assert.equal(isPeopleTrainingAccount({profileType:'contractor'}),false);
});
test('learner payload never includes answers or internal question fields',()=>{
 const questions=publicTrainingQuestions([{id:'q',prompt:'Question',question_type:'single_choice',options:['A','B'],correct_answers:['B'],private_note:'secret',points:1}]);
 assert.deepEqual(Object.keys(questions[0]).sort(),['id','options','points','prompt','question_type']);
 assert.equal(JSON.stringify(questions).includes('correct_answers'),false);
 assert.deepEqual(publicTrainingQuestions(null),[]);
});
