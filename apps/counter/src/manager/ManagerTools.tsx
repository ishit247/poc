import { useCallback, useEffect, useState } from 'react';
import { DayClose } from './DayClose.tsx';
import { MenuEditor } from './MenuEditor.tsx';
import { Modal } from './Modal.tsx';
import { Reports } from './Reports.tsx';
import { Settlements } from './Settlements.tsx';
import { Tablets } from './Tablets.tsx';
import { RefusedAck } from '../RefusedBanner.tsx';
import { api, type Me } from './api.ts';

type Tab = 'close' | 'reports' | 'settle' | 'tablets' | 'menu';

/** The manager's five areas. Profile, text size, theme and Sign out live in the header's More menu (see App.tsx). */
export function ManagerTools({ token, outletId, deviceId, onProfile }: { token: string; outletId?: string; deviceId?: string; onProfile?: (name: string) => void }) {
  const [tab, setTab] = useState<Tab>('close');
  const [blocking, setBlocking] = useState(0);
  const [menuDirty, setMenuDirty] = useState(false);
  const [leaveTo, setLeaveTo] = useState<Tab | null>(null);
  const onMenuDirty = useCallback((d: boolean) => setMenuDirty(d), []);
  useEffect(() => {
    void api('/me', token).then((r) => { if (r.status === 200) onProfile?.((r.body as Me).name); }).catch(() => { /* the menu just says "Manager" */ });
  }, [token, onProfile]);
  // Leaving the menu with unsaved edits asks first: the draft lives only in that screen.
  const go = (t: Tab) => { if (tab === 'menu' && menuDirty && t !== 'menu') setLeaveTo(t); else setTab(t); };
  const btn = (t: Tab, label: string, extra?: React.ReactNode) => (
    <button data-testid={`mgr-tab-${t}`} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => go(t)}>{label}{extra}</button>
  );
  return (
    <div className="m-wrap">
      {outletId && <RefusedAck token={token} outletId={outletId} />}
      <nav className="m-tabs" role="tablist">
        {btn('close', 'Close the day', blocking > 0 && <span className="m-count" aria-label={`${blocking} to sort out`}>{blocking}</span>)}
        {btn('reports', 'Reports')}
        {btn('settle', 'Settlements')}
        {btn('menu', 'Menu')}
        {btn('tablets', 'Tablets')}
      </nav>
      {tab === 'close' ? <DayClose token={token} onBlockers={setBlocking} /> : tab === 'reports' ? <Reports token={token} />
        : tab === 'settle' ? <Settlements token={token} /> : tab === 'menu' ? <MenuEditor token={token} onDirty={onMenuDirty} />
        : <Tablets token={token} thisDeviceId={deviceId} />}
      {leaveTo && (
        <Modal title="Leave without saving?" onClose={() => setLeaveTo(null)}>
          <p>Your menu changes are not saved. Leaving loses them.</p>
          <div className="actions"><button onClick={() => setLeaveTo(null)}>Keep editing</button>
            <button className="danger" data-testid="mgr-leave-menu" onClick={() => { setTab(leaveTo); setLeaveTo(null); }}>Leave</button></div>
        </Modal>
      )}
    </div>
  );
}
