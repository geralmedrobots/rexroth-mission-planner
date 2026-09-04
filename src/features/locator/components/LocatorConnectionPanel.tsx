import { CloudDone, Login, Logout, NetworkCheck } from '@mui/icons-material';
import {
  Alert, Button, FormControlLabel, Paper, Stack, Switch, TextField, Typography,
} from '@mui/material';
import { useRef, useState } from 'react';
import { LogService } from '../../../services/LogService';
import { locatorSessionService } from '../services/locatorSessionService';
import { useLocatorStore } from '../stores/locatorStore';

export function LocatorConnectionPanel() {
  const store = useLocatorStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [advanced,setAdvanced]=useState(false);
  const caInput = useRef<HTMLInputElement>(null);
  const update = store.updateSettings;

  const configure = async (): Promise<void> => {
    await locatorSessionService.connect(store.settings);
  };
  const test = async (): Promise<void> => {
    store.set({ connectionState: 'testing', error: undefined });
    try {
      await configure();
      const testResult = await locatorSessionService.test();
      if (!testResult.serverMapModule) throw new Error('ServerMap module is not available on this Locator Server.');
      store.set({ connectionState: 'ready', testResult, sessionState: 'logged-out', sessionId: undefined });
      LogService.write('system', 'info', `Locator RPC ready; ServerMap ${testResult.serverMapModule.majorVersion}.${testResult.serverMapModule.minorVersion}.`);
    } catch (error) {
      store.set({ connectionState: 'error', error: String(error) });
      LogService.write('system', 'error', `Locator connection test failed: ${String(error)}`);
    }
  };
  const login = async (): Promise<void> => {
    store.set({ sessionState: 'logging-in', error: undefined });
    try {
      await configure();
      const testResult = await locatorSessionService.test();
      if (!testResult.serverMapModule) throw new Error('ServerMap module is not available on this Locator Server.');
      const sessionId = await locatorSessionService.login(username, password);
      store.set({ sessionState: 'logged-in', sessionId, connectionState: 'ready', testResult });
      setPassword('');
      LogService.write('system', 'info', 'Locator sessionLogin succeeded.');
    } catch (error) {
      store.set({ sessionState: 'logged-out', error: String(error) });
      LogService.write('system', 'error', `Locator login failed: ${String(error)}`);
    }
  };
  const logout = async (): Promise<void> => {
    try { await locatorSessionService.logout(); }
    catch (error) { LogService.write('system', 'warning', `Locator logout: ${String(error)}`); }
    finally { store.set({ sessionState: 'logged-out', sessionId: undefined }); }
  };
  const automaticLogin=async():Promise<void>=>{
    store.set({sessionState:'logging-in',error:undefined});
    try{
      await configure();const testResult=await locatorSessionService.test();
      await locatorSessionService.automaticLogin();
      store.set({sessionState:'logged-in',connectionState:'ready',testResult});
      LogService.write('system','info','ROKIT Locator automatic sessionLogin succeeded.');
    }catch(error){
      store.set({sessionState:'logged-out',error:error instanceof Error?error.message:String(error)});
      LogService.write('system','error',`Locator automatic login failed: ${String(error)}`);
    }
  };

  return <Paper variant="outlined" sx={{ p: 1.5 }}>
    <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography variant="subtitle2">ROKIT Locator Connection</Typography>
      <Button onClick={()=>setAdvanced((value)=>!value)}>{advanced?'Hide advanced':'Advanced settings'}</Button>
    </Stack>
    {store.sessionState==='logged-in'&&!advanced?<Alert severity="success" icon={<CloudDone/>} sx={{mt:1}}>
      Secure Locator session connected to {store.settings.host}:{store.settings.port}.
    </Alert>:
    <Stack gap={1} mt={1}>
      <Stack direction="row" gap={1}>
        <TextField fullWidth size="small" label="Host" value={store.settings.host}
          onChange={(event) => update({ host: event.target.value })}/>
        <TextField sx={{ width: 130 }} size="small" type="number" label="RPC port" value={store.settings.port}
          onChange={(event) => update({ port: Number(event.target.value) })}/>
      </Stack>
      <Stack direction="row" gap={1}>
        <TextField fullWidth size="small" label="RPC endpoint" value={store.settings.rpcEndpoint}
          helperText="Confirm against the installed Locator configuration"
          onChange={(event) => update({ rpcEndpoint: event.target.value })}/>
        <TextField sx={{ width: 190 }} size="small" type="number" label="Pixels per meter"
          value={store.settings.imagePixelsPerMeter}
          onChange={(event) => update({ imagePixelsPerMeter: Number(event.target.value) })}/>
      </Stack>
      <Stack direction="row" gap={1}>
        <TextField fullWidth size="small" label="Username" value={username} autoComplete="username"
          onChange={(event) => setUsername(event.target.value)}/>
        <TextField fullWidth size="small" type="password" label="Password (never persisted)" value={password}
          autoComplete="current-password" onChange={(event) => setPassword(event.target.value)}/>
      </Stack>
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
        <FormControlLabel control={<Switch checked={store.settings.https}
          onChange={(event) => update({ https: event.target.checked })}/>} label="HTTPS"/>
        <Button size="small" onClick={() => caInput.current?.click()}>Select private CA</Button>
        <input hidden ref={caInput} type="file" accept=".pem,.crt,.cer" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void file.text().then((caCertificatePem) => update({ caCertificatePem }));
        }}/>
        <FormControlLabel control={<Switch color="warning" checked={store.settings.insecureDevelopmentMode}
          onChange={(event) => update({ insecureDevelopmentMode: event.target.checked })}/>}
          label="Insecure development mode"/>
      </Stack>
      {store.settings.insecureDevelopmentMode &&
        <Alert severity="warning">Certificate validation is disabled only for this Locator connection. Do not use this mode in production.</Alert>}
      {store.error && <Alert severity="error">{store.error}</Alert>}
      <Stack direction="row" gap={1} flexWrap="wrap">
        <Button startIcon={<NetworkCheck/>} onClick={() => void test()}>Test Connection</Button>
        <Button variant="contained" startIcon={<Login/>} disabled={store.sessionState === 'logging-in'}
          onClick={() => void login()}>Login</Button>
        <Button variant="outlined" startIcon={<Login/>} disabled={store.sessionState==='logging-in'}
          onClick={()=>void automaticLogin()}>Automatic Login</Button>
        <Button startIcon={<Logout/>} disabled={store.sessionState !== 'logged-in'}
          onClick={() => void logout()}>Logout</Button>
        {store.connectionState === 'ready' && <CloudDone color="success"/>}
      </Stack>
    </Stack>}
  </Paper>;
}
