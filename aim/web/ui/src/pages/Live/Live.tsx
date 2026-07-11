import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';

import BusyLoaderWrapper from 'components/BusyLoaderWrapper/BusyLoaderWrapper';

import { PathEnum } from 'config/enums/routesEnum';

import { useLiveSessions } from './liveStore';
import DemoShowcase from './DemoShowcase';
import SessionList from './SessionList';
import Workspace from './Workspace/Workspace';

import './Live.scss';

function useSelectedRun(): [string | null, (hash: string | null) => void] {
  const history = useHistory();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const selected = params.get('run');

  const setSelected = React.useCallback(
    (hash: string | null) => {
      const next = new URLSearchParams(location.search);
      if (hash) {
        next.set('run', hash);
      } else {
        next.delete('run');
      }
      history.push(`${PathEnum.Live}?${next.toString()}`);
    },
    [history, location.search],
  );

  return [selected, setSelected];
}

function Live(): React.FunctionComponentElement<React.ReactNode> {
  const { sessions, loading } = useLiveSessions();
  const [selectedRun, setSelectedRun] = useSelectedRun();

  const activeSession = React.useMemo(
    () => sessions.find((s) => s.run_hashes.includes(selectedRun || '')),
    [sessions, selectedRun],
  );

  // A session opens only when explicitly selected (card click) or via a
  // `?run=<hash>` deep link — the `/live` landing always shows the list.
  if (selectedRun) {
    return (
      <Workspace
        runHash={selectedRun}
        session={activeSession}
        onBack={() => setSelectedRun(null)}
      />
    );
  }

  return (
    <section className='Live'>
      <div className='Live__header'>
        <h2 className='Live__title'>Interactive Training</h2>
        <span className='Live__subtitle'>
          Inspect and control active training through one auditable protocol.
        </span>
      </div>
      <DemoShowcase />
      <BusyLoaderWrapper
        isLoading={loading && sessions.length === 0}
        height='100%'
      >
        <SessionList sessions={sessions} onSelect={setSelectedRun} />
      </BusyLoaderWrapper>
    </section>
  );
}

export default Live;
