import { NextResponse } from "next/server";
import { chromium as localChromium, Page } from "playwright-core";
import chromium from "@sparticuz/chromium";
import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";

export const maxDuration = 60; // Max allowed for Vercel Hobby plan

interface ScrapedField {
    id: string;
    tagName: string;
    type: string;
    label: string;
    options?: string[];
    value?: string | boolean;
}

interface ScrapedButton {
    id: string;
    text: string;
    tagName: string;
}

export async function POST(req: Request) {
    const { url, personaOverrides } = await req.json();

    if (!url || !url.startsWith("http")) {
        return NextResponse.json({ error: "A valid URL is required" }, { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const sendUpdate = (log: string | null, screenshot?: string, data?: any) => {
                const payload = JSON.stringify({ log, screenshot, data });
                controller.enqueue(encoder.encode(payload + "\n"));
            };

            let browser = null;
            let isStreamingFrames = true;
            try {
                sendUpdate("Setting up browser instance...");
                const isLocal = process.env.NODE_ENV !== "production";

                const launchOptions: any = {
                    headless: true,
                    // @ts-ignore
                    args: isLocal ? undefined : chromium.args,
                    // @ts-ignore
                    defaultViewport: chromium.defaultViewport,
                    executablePath: isLocal
                        ? "C:\\Users\\Joshua\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
                        : await chromium.executablePath(),
                    slowMo: 250, // Delays every individual Playwright action by 250ms for realistic viewing
                };

                if (process.env.PROXY_SERVER) {
                    launchOptions.proxy = {
                        server: process.env.PROXY_SERVER,
                        username: process.env.PROXY_USERNAME || undefined,
                        password: process.env.PROXY_PASSWORD || undefined,
                    };
                }

                browser = await localChromium.launch(launchOptions);
                const context = await browser.newContext({
                    timezoneId: 'America/New_York',
                    locale: 'en-US',
                    geolocation: { longitude: -74.006, latitude: 40.7128 },
                    permissions: ['geolocation']
                });

                const page = await context.newPage();

                sendUpdate(`Navigating to ${url}...`);
                try {
                    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
                } catch (navError: any) {
                    sendUpdate(`Navigation warning: ${navError.message}`);
                }

                const streamFrames = async () => {
                    while (isStreamingFrames) {
                        try {
                            const buf = await page.screenshot({ type: "jpeg", quality: 40 });
                            sendUpdate(null, `data:image/jpeg;base64,${buf.toString("base64")}`);
                        } catch (e) { }
                        await new Promise(r => setTimeout(r, 200)); // ~5 FPS
                    }
                };
                streamFrames();

                let isDone = false;

                req.signal.addEventListener("abort", () => {
                    isDone = true;
                    isStreamingFrames = false;
                    console.log("Client aborted stream. Halting bot.");
                });
                let iterations = 0;
                const maxIterations = 25;
                let finalAnswers: Record<string, any> = {};

                while (!isDone && iterations < maxIterations) {
                    iterations++;
                    sendUpdate(`--- Starting Step ${iterations} ---`);

                    await new Promise(r => setTimeout(r, 10000)); // Paced to 6 RPM to strictly avoid free tier limits

                    sendUpdate(`Gathering page context...`);
                    const pageState = await extractPageState(page);

                    sendUpdate(`Consulting Gemini LLM to decide next action...`);
                    let decision;
                    let retries = 0;
                    while (true) {
                        try {
                            decision = await makeDecisionWithLLM(pageState, personaOverrides);
                            break;
                        } catch (aiError: any) {
                            const errMsg = aiError.message ? aiError.message.toLowerCase() : "";
                            if (retries < 10 && (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('rate limit') || errMsg.includes('retry'))) {
                                sendUpdate(`⚠️ LLM Rate Limit Hit (Free Tier). Pausing automation for 60 seconds to clear quota...`);
                                await new Promise(r => setTimeout(r, 60000));
                                retries++;
                            } else {
                                throw aiError;
                            }
                        }
                    }
                    sendUpdate(`[LLM ACTION: ${decision.action}] -> ${decision.reasoning}`);

                    if (decision.action === "DONE") {
                        isDone = true;
                        break;
                    }

                    if (decision.action === "FILL" && decision.fillData) {
                        sendUpdate("Filling mapped form fields...");
                        const fillRecord: Record<string, string> = {};
                        for (const item of decision.fillData) {
                            fillRecord[item.id] = item.value;
                        }
                        await FillFormFields(page, fillRecord);
                        finalAnswers = { ...finalAnswers, ...fillRecord };
                        sendUpdate("Fields filled.");
                    }

                    if (decision.action === "CLICK" && decision.clickTargetId) {
                        sendUpdate(`Clicking on #${decision.clickTargetId}`);
                        try {
                            await page.click(`#${decision.clickTargetId}`, { timeout: 5000 });
                            await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => { });
                        } catch (e: any) {
                            sendUpdate(`Fallback click logic triggered...`);
                            try {
                                const btns = await page.locator(`text="${decision.clickTargetId}"`);
                                if (await btns.count() > 0) {
                                    await btns.first().click({ timeout: 5000 });
                                    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => { });
                                }
                            } catch (e2) {
                                sendUpdate(`Click failed.`);
                            }
                        }
                    }
                }

                sendUpdate(`Automation Finished! (Completed ${iterations} loop cycles)`);
            } catch (error: any) {
                if (!req.signal.aborted) {
                    sendUpdate(`ERROR: ${error.message}`);
                    controller.enqueue(encoder.encode(JSON.stringify({ error: error.message }) + "\n"));
                }
            } finally {
                isStreamingFrames = false;
                if (browser) await browser.close();
                try {
                    controller.close();
                } catch (e) { }
            }
        }
    });

    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
}

async function extractPageState(page: Page) {
    return await page.evaluate(() => {
        // Limited text extraction for LLM to read instructions
        let pageText = document.body.innerText || "";
        pageText = pageText.substring(0, 3000);

        // Extract Forms
        const elements = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
            "input:not([type='hidden']):not([type='submit']), textarea, select"
        );
        const fields: ScrapedField[] = [];
        elements.forEach((el, index) => {
            let labelText = "";
            if (el.id) {
                const label = document.querySelector(`label[for="${el.id}"]`);
                if (label) labelText = (label as HTMLElement).innerText;
            }
            if (!labelText) {
                const parentLabel = el.closest("label");
                if (parentLabel) labelText = (parentLabel as HTMLElement).innerText;
            }
            if (!el.id) el.id = `auto-field-${index}`;

            let fieldOptions: string[] | undefined;
            if (el.tagName.toLowerCase() === "select") {
                const selectEl = el as HTMLSelectElement;
                fieldOptions = Array.from(selectEl.options).map(opt => opt.value || opt.text).filter(Boolean);
            }

            let currentValue: string | boolean | undefined;
            if (el.type === "checkbox" || el.type === "radio") {
                currentValue = (el as HTMLInputElement).checked;
            } else {
                currentValue = el.value;
            }

            fields.push({
                id: el.id,
                tagName: el.tagName.toLowerCase(),
                type: el.type || el.tagName.toLowerCase(),
                label: labelText.trim(),
                value: currentValue,
                ...(fieldOptions ? { options: fieldOptions } : {}),
            });
        });

        // Extract Buttons & Links
        const btnElements = document.querySelectorAll<HTMLElement>("button, input[type='submit'], input[type='button'], a");
        const clickables: ScrapedButton[] = [];
        btnElements.forEach((el, index) => {
            if (!el.id) el.id = `auto-btn-${index}`;
            const text = el.innerText || (el as HTMLInputElement).value || "Submit/Next/Link";
            if (text.trim().length > 0) {
                clickables.push({
                    id: el.id,
                    text: text.trim().substring(0, 60),
                    tagName: el.tagName.toLowerCase(),
                });
            }
        });

        return { pageText, fields, clickables };
    });
}

async function FillFormFields(page: Page, answers: Record<string, string | boolean>) {
    for (const [id, value] of Object.entries(answers)) {
        const selector = `#${id}`;
        try {
            const element = await page.$(selector);
            if (!element) continue;

            const typeInfo = await element.evaluate((el: any) => el.type);

            if (typeInfo === "checkbox" || typeInfo === "radio") {
                if (value === true || value === "true") {
                    await page.check(selector, { timeout: 5000 });
                }
            } else if (typeInfo === "select-one" || typeInfo === "select-multiple") {
                await page.selectOption(selector, String(value), { timeout: 5000 });
            } else {
                await page.fill(selector, String(value), { timeout: 5000 });
            }
        } catch (fillError: any) {
            console.warn(`Could not fill field ${selector}:`, fillError.message);
        }
    }
}

async function makeDecisionWithLLM(pageState: any, overrides?: any) {
    const userOverrides = overrides || {};
    const PERSONA = `
    Name: ${userOverrides.name || 'John Doe'}
    Age: ${userOverrides.age || '32'}
    Sex/Gender: ${userOverrides.gender || 'Male'}
    Email: ${userOverrides.email || 'j.doe@example.com'}
    Phone: ${userOverrides.phone || '(555) 123-4567'}
    Location: San Francisco, CA
    Role: Senior Full-Stack Web Developer
    Tech Stack: React, Next.js, Node.js, Typescript, Tailwind CSS, Playwright.
    Background: Worked in tech for 8 years.
    Availability: Open to new opportunities.
  `;

    const result = await generateObject({
        model: google("gemini-2.5-flash"),
        schema: z.object({
            action: z.enum(['CLICK', 'FILL', 'DONE']).describe("Choose FILL if there are empty form fields. Choose CLICK if you need to bypass an instruction screen or submit a filled form. Choose DONE if a success screen is visible or no more progressing is possible."),
            clickTargetId: z.string().optional().describe("If action is CLICK, provide the exact 'id' of the relevant button/link from the clickables array."),
            fillData: z.array(z.object({ id: z.string(), value: z.string() })).optional().describe("If action is FILL, provide a list of objects with the exact field 'id' and your generated 'value'."),
            reasoning: z.string().describe("Explain briefly why you chose this action based on the visible page text, fields, and persona context.")
        }),
        system: `
      You are an expert autonomous web form navigation agent. 
      You are presented with the live state of a webpage (Text, Form Fields, and Clickable Buttons/Links).
      
      USER PERSONA:
      ${PERSONA}

      RULES for your loop logic:
      1. INSTRUCTIONS PAGE: If no form fields are present but there are instructions and a "Next", "Start", or "Agree" button, choose CLICK and target that button's 'id'.
      2. FILLING A FORM: If there are un-filled form fields mapped out, choose FILL and carefully synthesize plausible answers for them using the PERSONA.
      3. SUBMITTING: If the form fields are clearly already filled out with your data (you see them in the values array), choose CLICK and target the Submit or Next button ID.
      4. SUCCESS: If you read a success message in the page text (e.g., "Thank you", "Submitted successfully, we will be in touch") and no more actionable forms exist, choose DONE.
    `,
        prompt: `Current Snapshot of Webpage State: \n\n ${JSON.stringify(pageState, null, 2)}`
    });

    return result.object;
}
