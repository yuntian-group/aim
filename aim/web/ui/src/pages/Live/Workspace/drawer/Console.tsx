import React from 'react';

import { ILiveSessionStore } from '../../liveStore';

interface IConsoleProps {
  store: ILiveSessionStore;
  disabled?: boolean;
}

const HISTORY_KEY = 'live.consoleHistory';

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function Console({
  store,
  disabled,
}: IConsoleProps): React.FunctionComponentElement<React.ReactNode> {
  const [value, setValue] = React.useState('');
  const [log, setLog] = React.useState<string[]>([]);
  const historyRef = React.useRef<string[]>(loadHistory());
  const cursorRef = React.useRef<number>(historyRef.current.length);

  const pushLog = (line: string) =>
    setLog((prev) => [...prev.slice(-100), line]);

  const send = async () => {
    const text = value.trim();
    if (!text) {
      return;
    }
    let action: any;
    try {
      action = JSON.parse(text);
    } catch (e) {
      pushLog(`✗ invalid JSON: ${(e as Error).message}`);
      return;
    }
    if (!action.type) {
      pushLog('✗ action requires a "type" field');
      return;
    }
    const history = [...historyRef.current, text].slice(-50);
    historyRef.current = history;
    cursorRef.current = history.length;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));

    pushLog(`→ ${text}`);
    setValue('');
    const id = await store.submitAction(action);
    pushLog(id ? `← queued id=${id.slice(0, 8)}` : '✗ submit failed');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      send();
    } else if (e.key === 'ArrowUp') {
      const hist = historyRef.current;
      if (hist.length > 0) {
        cursorRef.current = Math.max(0, cursorRef.current - 1);
        setValue(hist[cursorRef.current] || '');
        e.preventDefault();
      }
    } else if (e.key === 'ArrowDown') {
      const hist = historyRef.current;
      cursorRef.current = Math.min(hist.length, cursorRef.current + 1);
      setValue(hist[cursorRef.current] || '');
      e.preventDefault();
    }
  };

  return (
    <div className='Console'>
      <div className='Console__log'>
        {log.map((line, i) => (
          <div key={i} className='Console__line'>
            {line}
          </div>
        ))}
      </div>
      <div className='Console__input'>
        <span className='Console__prompt'>&gt;</span>
        <input
          type='text'
          value={value}
          placeholder='{"type":"note","payload":{"text":"hi"}}'
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type='button' disabled={disabled} onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}

export default Console;
