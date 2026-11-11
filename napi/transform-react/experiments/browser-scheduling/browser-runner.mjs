// Execute in the Playwright host process, not inside page.evaluate.
export async function runBrowser(page, url, { timeoutMs = 125000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Browser driver timeout must be positive");
  }
  let timer;
  let activeCell = null;
  let lastCell = null;
  const observeRequest = (request) => {
    if (request.method() !== "POST") return;
    const { pathname } = new URL(request.url());
    if (pathname === "/progress") {
      activeCell = JSON.parse(request.postData()).cell;
      lastCell = activeCell;
    } else if (pathname === "/cell-result") {
      activeCell = null;
    }
  };
  page.on("request", observeRequest);
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`External Playwright process deadline exceeded (${timeoutMs} ms)`);
      error.name = "BrowserProcessTimeout";
      error.details = { url, timeoutMs, activeCell, lastCell };
      reject(error);
      page.close({ runBeforeUnload: false }).catch(() => {});
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        await page.goto(url);
        return page.evaluate(() => window.__schedulingDone);
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    page.off("request", observeRequest);
  }
}
