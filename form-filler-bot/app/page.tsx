"use client";

import { useState, useRef, useEffect } from "react";

export default function Home() {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [liveImage, setLiveImage] = useState<string | null>(null);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = (message: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${message}`]);
  };

  const runAutomation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setIsLoading(true);
    setLogs([]);
    setLiveImage(null);
    addLog("Starting live streaming automation...");

    const controller = new AbortController();
    setAbortController(controller);

    try {
      const response = await fetch("/api/run-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, personaOverrides: { name, age, gender, email, phone } }),
        signal: controller.signal,
      });

      if (!response.body) throw new Error("No readable stream available.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let doneReading = false;
      let buffer = "";

      while (!doneReading) {
        const { value, done } = await reader.read();
        doneReading = done;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.log) addLog(parsed.log);
                if (parsed.screenshot) setLiveImage(parsed.screenshot);
                if (parsed.error) addLog(`ERROR: ${parsed.error}`);
              } catch (e) { }
            }
          }
        }
      }

      addLog("Stream connection closed.");

    } catch (err: any) {
      if (err.name === 'AbortError') {
        addLog(`WARNING: Automation aborted by user.`);
      } else {
        addLog(`ERROR: ${err.message}`);
      }
    } finally {
      setIsLoading(false);
      setAbortController(null);
    }
  };

  const handleStop = () => {
    if (abortController) {
      abortController.abort();
    }
  };

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center py-16 px-4">
      <div className="w-full max-w-5xl space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-extrabold tracking-tight text-white">AutoForm AI Live Stream</h1>
          <p className="text-neutral-400">Autonomous web form filler powered by Playwright and Gemini</p>
        </div>

        <form onSubmit={runAutomation} className="flex flex-col gap-4 max-w-3xl mx-auto bg-neutral-900 p-6 rounded-xl border border-neutral-800 shadow-xl">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-2">
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Full Name (optional)" className="px-4 py-2 rounded-lg bg-neutral-950 border border-neutral-800 text-white placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500 text-sm" disabled={isLoading} />
            <input type="number" value={age} onChange={e => setAge(e.target.value)} placeholder="Age (optional)" className="px-4 py-2 rounded-lg bg-neutral-950 border border-neutral-800 text-white placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500 text-sm" disabled={isLoading} />
            <input type="text" value={gender} onChange={e => setGender(e.target.value)} placeholder="Sex (optional)" className="px-4 py-2 rounded-lg bg-neutral-950 border border-neutral-800 text-white placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500 text-sm" disabled={isLoading} />
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email (optional)" className="px-4 py-2 rounded-lg bg-neutral-950 border border-neutral-800 text-white placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500 text-sm" disabled={isLoading} />
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone (optional)" className="px-4 py-2 rounded-lg bg-neutral-950 border border-neutral-800 text-white placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500 text-sm" disabled={isLoading} />
          </div>

          <div className="flex gap-4">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste form URL here (e.g., https://example.com/form)"
              className="flex-1 px-4 py-3 rounded-lg bg-neutral-900 border border-neutral-800 text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
              required
              disabled={isLoading}
            />
            {isLoading && (
              <button
                type="button"
                onClick={handleStop}
                className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-all shadow-lg min-w-[120px]"
              >
                Stop Bot
              </button>
            )}
            <button
              type="submit"
              disabled={isLoading}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-all shadow-lg min-w-[160px]"
            >
              {isLoading ? "Running..." : "Run Automation"}
            </button>
          </div>
        </form>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-4">
          {/* Terminal Window */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 h-[600px] overflow-y-auto font-mono text-xs shadow-inner flex flex-col relative w-full">
            <h2 className="text-sm uppercase tracking-widest text-neutral-500 font-semibold border-b border-neutral-800 pb-2 mb-2 sticky top-0 bg-neutral-900 z-10">Console Logs</h2>
            {logs.length === 0 ? (
              <span className="text-neutral-600 italic mt-2">No logs yet. Awaiting initialization...</span>
            ) : (
              <ul className="space-y-2 mt-2 break-words">
                {logs.map((log, idx) => (
                  <li key={idx} className={log.includes("ERROR") || log.includes("warning") ? "text-red-400" : log.includes("LLM ACTION") ? "text-blue-400" : "text-green-400"}>
                    {log}
                  </li>
                ))}
                <div ref={logsEndRef} />
              </ul>
            )}
          </div>

          {/* Live Web View */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg h-[600px] shadow-inner overflow-hidden flex flex-col relative w-full">
            <h2 className="text-sm uppercase tracking-widest text-neutral-500 font-semibold border-b border-neutral-800 p-4 absolute top-0 left-0 w-full bg-neutral-900 z-10">Live Web View</h2>
            <div className="w-full h-full pt-[53px]">
              {liveImage ? (
                <img src={liveImage} alt="Live Playwright View" className="w-full h-full object-contain bg-black" />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-black/50">
                  <span className="text-neutral-500 italic">No live view available. Waiting for bot...</span>
                </div>
              )}
            </div>
          </div>
        </div>

      </div>
    </main>
  );
}
