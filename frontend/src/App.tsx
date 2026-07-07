import {useState} from 'react';
import {Greet} from "../wailsjs/go/main/App";

function App() {
    const [resultText, setResultText] = useState('');

    function ping() {
        Greet('mini-tools').then(setResultText);
    }

    return (
        <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 text-neutral-100">
            <div className="flex flex-col items-center gap-4">
                <h1 className="text-2xl font-semibold">mini-tools</h1>
                <p className="text-sm text-neutral-400">scaffold: Wails + React + Tailwind (dark by default)</p>
                <button
                    className="rounded bg-neutral-800 px-4 py-2 text-sm hover:bg-neutral-700"
                    onClick={ping}
                >
                    Ping backend
                </button>
                {resultText && <p className="text-sm text-emerald-400">{resultText}</p>}
            </div>
        </div>
    )
}

export default App
