import assert from "node:assert/strict";
import test from "node:test";
import { nativeModelAccessError, nativeModelAccessSse } from "../src/native-model-access.mjs";
const model = "gpt-daybreak-blue-latest";
test("only explicit model access errors authorize native account fallback", () => {
  for (const code of ["model_not_found", "model_not_supported", "model_access_denied", "unsupported_model"]) {
    assert.equal(nativeModelAccessError({ code }, model), true);
  }
  assert.equal(nativeModelAccessError({ message: "The '" + model + "' model is not supported with your account." }, model), true);
  for (const error of [{code:"insufficient_quota"},{code:"account_deactivated"},{message:"Access denied"},{message:"Not Found"},{message:"Selected model is at capacity"},{message:"Some other model is unavailable"},null]) {
    assert.equal(nativeModelAccessError(error, model), false);
  }
});
const frame = (value) => "data: " + JSON.stringify(value) + "\n\n";
test("SSE fallback accepts an early structured failure, not partial output or text containing error words", () => {
  const denied = frame({type:"response.failed",response:{error:{code:"model_not_found"}}});
  assert.equal(nativeModelAccessSse(frame({type:"response.created"}) + denied, model), "denied");
  assert.equal(nativeModelAccessSse(denied.slice(0,-1), model), "pending");
  assert.equal(nativeModelAccessSse(frame({type:"response.output_text.delta",delta:"model_not_found"}) + denied, model), "output");
  assert.equal(nativeModelAccessSse(frame({type:"response.output_item.added",item:{type:"function_call"}}) + denied, model), "output");
  assert.equal(nativeModelAccessSse(frame({type:"error",error:{code:"insufficient_quota"}}),model), "failure");
});

test("output-bearing failure and prelude envelopes cannot authorize replay", () => {
  for(const type of ["response.failed","response.created"]){
    const packet={type,response:{output:[{type:"function_call",name:"write_file"}],error:{code:"model_not_found"}}};
    assert.equal(nativeModelAccessSse(frame(packet),model),"output");
  }
});

test("SSE event metadata identifies an error without a redundant JSON type", () => {
 assert.equal(nativeModelAccessSse('event: error\ndata: {"error":{"code":"model_not_found"}}\n\n',model),"denied");
});

test("explicit quota and authentication codes outrank incidental model wording", () => {
  for(const code of ["insufficient_quota","account_deactivated","invalid_api_key","rate_limit_exceeded","server_is_overloaded"]){
    assert.equal(nativeModelAccessError({code,message:"The model "+model+" is not available for this account"},model),false);
  }
});
test("a top-level SSE output prevents replay too", () => {
  assert.equal(nativeModelAccessSse(frame({type:"error",output:[{type:"message"}],error:{code:"model_not_found"}}),model),"output");
});
