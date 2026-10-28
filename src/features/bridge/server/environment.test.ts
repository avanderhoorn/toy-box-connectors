import { describe, expect, test } from "bun:test";
import { defaultWakeTimings } from "@wakes/model";
import { resolveToyBoxOrigin, resolveWakeTimings } from "./environment";
import { BridgeRefusedError } from "./refusal";

describe("the Toy Box origin", () => {
  test("is Toy Box's own address unless TOY_BOX_URL names another", () => {
    expect(resolveToyBoxOrigin({}).href).toBe("http://127.0.0.1:3000/");
    expect(resolveToyBoxOrigin({ TOY_BOX_URL: "" }).href).toBe("http://127.0.0.1:3000/");
    expect(resolveToyBoxOrigin({ TOY_BOX_URL: "http://localhost:3100" }).href).toBe(
      "http://localhost:3100/",
    );
  });

  test("refuses a Toy Box anywhere but this Mac", () => {
    for (const url of ["https://127.0.0.1:3000", "http://10.0.0.2:3000", "toy-box"]) {
      const resolve = () => resolveToyBoxOrigin({ TOY_BOX_URL: url });
      expect(resolve).toThrow(BridgeRefusedError);
      expect(resolve).toThrow(
        `TOY_BOX_URL must be an http URL on this Mac, such as http://127.0.0.1:3000, but it's "${url}".`,
      );
    }
  });
});

describe("the wake timings", () => {
  test("are the policy's own unless TOY_BOX_SLACK_WAKE_TIMINGS sets some", () => {
    expect(resolveWakeTimings({})).toBe(defaultWakeTimings);
    expect(
      resolveWakeTimings({ TOY_BOX_SLACK_WAKE_TIMINGS: '{"debounce":100,"backoff":[1,2,3]}' }),
    ).toEqual({ ...defaultWakeTimings, debounce: 100, backoff: [1, 2, 3] });
  });

  test("refuses anything but a JSON object of known timings in whole milliseconds", () => {
    const refusals = {
      "{debounce: 100}": "expected object, received string",
      "[100]": "expected object, received array",
      '{"debunce":100}': 'Unrecognized key: "debunce"',
      '{"debounce":-1}': "expected number to be >=0",
      '{"debounce":1.5}': "expected int, received number",
      '{"backoff":[1,2]}': "expected array to have >=3 items",
    };
    for (const [value, problem] of Object.entries(refusals)) {
      const resolve = () => resolveWakeTimings({ TOY_BOX_SLACK_WAKE_TIMINGS: value });
      expect(resolve).toThrow(BridgeRefusedError);
      expect(resolve).toThrow(problem);
    }
  });
});
