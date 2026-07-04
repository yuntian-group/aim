import React from 'react';

import { ILiveSession } from 'types/services/models/live/live';

import { useLiveSession } from '../liveStore';

import Header from './Header';
import PanelRail from './PanelRail';
import RoundRail from './RoundRail';
import ProgressStrip from './ProgressStrip';
import LiveCharts from './charts/LiveCharts';
import BottomDrawer from './drawer/BottomDrawer';

import './Workspace.scss';

interface IWorkspaceProps {
  runHash: string;
  session?: ILiveSession;
  onBack: () => void;
}

function Workspace({
  runHash,
  session,
  onBack,
}: IWorkspaceProps): React.FunctionComponentElement<React.ReactNode> {
  const store = useLiveSession(runHash, session?.run_hashes);

  const protocolVersion = store.state?.v;
  const unsupported = protocolVersion !== undefined && protocolVersion !== 2;

  const archived = store.connection === 'ended';

  return (
    <section className='LiveWorkspace'>
      <Header
        runHash={runHash}
        session={session}
        store={store}
        onBack={onBack}
      />
      {unsupported && (
        <div className='LiveWorkspace__banner LiveWorkspace__banner--warn'>
          Unsupported control protocol version (v{protocolVersion}). The UI
          expects v2.
        </div>
      )}
      {archived && (
        <div className='LiveWorkspace__banner LiveWorkspace__banner--ended'>
          Session ended — controls are frozen. Charts and events below reflect
          the last known state.
        </div>
      )}
      <RoundRail store={store} />
      <div className='LiveWorkspace__body'>
        <PanelRail
          runHash={runHash}
          session={session}
          store={store}
          disabled={archived}
        />
        <div className='LiveWorkspace__main'>
          {store.isMultiround && <ProgressStrip store={store} />}
          <LiveCharts store={store} />
          <BottomDrawer runHash={runHash} store={store} disabled={archived} />
        </div>
      </div>
    </section>
  );
}

export default Workspace;
