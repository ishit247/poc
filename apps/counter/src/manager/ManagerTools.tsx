import { useState } from 'react';
import { DayClose } from './DayClose.tsx';
import { Reports } from './Reports.tsx';
import { Settlements } from './Settlements.tsx';
import { RefusedAck } from '../RefusedBanner.tsx';

export function ManagerTools({ token, onDone, outletId }: { token: string; onDone: () => void; outletId?: string }) {
  const [tab, setTab] = useState<'close' | 'reports' | 'settle'>('close');
  return (
    <>
      {outletId && <RefusedAck token={token} outletId={outletId} />}
      <nav>
        <button data-testid="mgr-tab-close" className={tab === 'close' ? 'active' : ''} onClick={() => setTab('close')}>Close the day</button>
        <button data-testid="mgr-tab-reports" className={tab === 'reports' ? 'active' : ''} onClick={() => setTab('reports')}>Reports</button>
        <button data-testid="mgr-tab-settle" className={tab === 'settle' ? 'active' : ''} onClick={() => setTab('settle')}>Settlements</button>
      </nav>
      {tab === 'close' ? <DayClose token={token} onDone={onDone} /> : tab === 'reports' ? <Reports token={token} /> : <Settlements token={token} />}
    </>
  );
}
