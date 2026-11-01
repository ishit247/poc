import { useState } from 'react';
import { DayClose } from './DayClose.tsx';
import { Settlements } from './Settlements.tsx';

export function ManagerTools({ token, onDone }: { token: string; onDone: () => void }) {
  const [tab, setTab] = useState<'close' | 'settle'>('close');
  return (
    <>
      <nav>
        <button data-testid="mgr-tab-close" className={tab === 'close' ? 'active' : ''} onClick={() => setTab('close')}>Close the day</button>
        <button data-testid="mgr-tab-settle" className={tab === 'settle' ? 'active' : ''} onClick={() => setTab('settle')}>Settlements</button>
      </nav>
      {tab === 'close' ? <DayClose token={token} onDone={onDone} /> : <Settlements token={token} />}
    </>
  );
}
