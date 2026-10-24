import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { API, useProjectRoutes } from "./fixtures/project-routes";

const SUBMIT = "/api/cli/stores/submit";
const FILES = ["ocr/lang/deu.traineddata", "ocr/lang/eng.traineddata.gz"];
const PLATFORM_MESSAGE =
  'The Edge package of build 2bda5b2 carries 2 compressed files (ocr/lang/deu.traineddata, ocr/lang/eng.traineddata.gz). Partner Center refuses any archive in an extension package: "The uploaded package consists of a compressed file. Please remove the file and try uploading the package again." Ship the files uncompressed and rebuild; for Tesseract, ship `.traineddata` uncompressed (Tesseract.js takes `gzip: false`). Nothing was dispatched.';

describe("extension_submit renders the platform's Edge package refusal", () => {
  const platform = useProjectRoutes("extdev-edge-package-");

  it("answers package-refused with the file names, the Tesseract hint and the build page, and reports no approval spent", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.login();
    let dispatchCalls = 0;

    platform.routes[`POST ${SUBMIT}`] = () => {
      dispatchCalls += 1;

      return {
        status: 409,
        body: {
          ok: false,
          code: "EDGE_PACKAGE_HAS_ARCHIVES",
          message: PLATFORM_MESSAGE,
          store: "edge",
          files: FILES,
          hint: "Ship the files uncompressed and rebuild; for Tesseract, ship `.traineddata` uncompressed (Tesseract.js takes `gzip: false`).",
          refusedBeforeApproval: true,
        },
      };
    };

    const out = JSON.parse(
      await submit({ browsers: ["edge"], buildSha: "2bda5b2", dryRun: false, api: API }),
    );

    expect(dispatchCalls).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("package-refused");
    expect(out.error.platformCode).toBe("EDGE_PACKAGE_HAS_ARCHIVES");
    expect(out.error.name).toBe("EdgePackageRefused");
    expect(out.value.files).toEqual(FILES);
    expect(out.value.store).toBe("edge");
    expect(out.value.buildSha).toBe("2bda5b2");
    expect(out.value.trackUrl).toMatch(/^http:\/\/console\.extension\.localhost\/acme\/widget\//);
    expect(out.value.trackUrl).toContain("2bda5b2");
    expect(out.value.nextStep).toMatchObject({ kind: "resubmit", url: out.value.trackUrl });
    expect(out.hint).toContain("ocr/lang/eng.traineddata.gz");
    expect(out.hint).toContain("ship `.traineddata` uncompressed (Tesseract.js takes `gzip: false`)");
    expect(out.hint).toContain("nothing was submitted");
    expect(out.value.sayToPerson).toBe(out.hint);
    expect(JSON.stringify(out)).not.toMatch(/mirror|workflow run|Actions run/i);
  });
});
