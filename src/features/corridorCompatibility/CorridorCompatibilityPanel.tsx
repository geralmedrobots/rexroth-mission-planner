import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  TextField, Typography,
} from '@mui/material';
import {
  getCorridorCompatibilityConclusion, getCorridorCompatibilityReport,
} from './CorridorCompatibilityService';
import { useCorridorCompatibilityStore } from './corridorCompatibilityStore';
import {
  corridorVariantLabels, type CorridorTestVariant,
} from './types';

interface CorridorCompatibilityPanelProps {
  open:boolean;
  onClose:()=>void;
  onRun:(variant:CorridorTestVariant)=>Promise<void>;
  dispatchBlockedReason?:string;
}

const variantKeys=Object.keys(corridorVariantLabels) as CorridorTestVariant[];

export const CorridorCompatibilityPanel=({
  open,onClose,onRun,dispatchBlockedReason,
}:CorridorCompatibilityPanelProps)=>{
  const store=useCorridorCompatibilityStore();
  const report=getCorridorCompatibilityReport();
  const conclusion=getCorridorCompatibilityConclusion(store.results);
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="xl">
    <DialogTitle>ROKIT Corridor Compatibility Test</DialogTitle>
    <DialogContent>
      <Alert severity="warning" sx={{mb:2}}>
        This developer test commands robot motion. Run one variant at a time in a controlled area;
        every publication requires operator confirmation.
      </Alert>
      <Alert severity={conclusion==='rejected'?'error':conclusion==='used'?'success':'info'}
        sx={{mb:2}}>
        Evidence conclusion: {conclusion}. “Ignored” is never inferred solely from a missing
        corridor echo or from one run without a bypass.
      </Alert>
      <Paper variant="outlined" sx={{p:1.5,mb:2}}>
        <Typography variant="overline">Compatibility report</Typography>
        <Stack direction={{xs:'column',md:'row'}} gap={3}>
          <Box>
            <Typography variant="body2">Protocol base: VDA 5050 2.0</Typography>
            <Typography variant="body2">Order version: 2.0.0</Typography>
            <Typography variant="body2">Field: {report.fieldName}.{report.referencePointFieldName}</Typography>
          </Box>
          <Box>
            <Typography variant="body2">Enum: {report.enumValues.join(' | ')}</Typography>
            <Typography variant="body2">Definition: {report.definedIn}</Typography>
            <Typography variant="body2" color="warning.main">
              Bosch schema: {report.installedBoschSchemaConfirmation}
            </Typography>
          </Box>
        </Stack>
      </Paper>
      <Stack direction={{xs:'column',lg:'row'}} gap={2}>
        <Paper variant="outlined" sx={{p:1.5,minWidth:{lg:330}}}>
          <Typography variant="overline">Controlled variants</Typography>
          <Stack gap={1} mt={1}>
            {variantKeys.map((variant)=><Button key={variant} variant="outlined"
              disabled={Boolean(dispatchBlockedReason)}
              onClick={()=>void onRun(variant)}>{corridorVariantLabels[variant]}</Button>)}
          </Stack>
          {dispatchBlockedReason&&<Alert severity="error" sx={{mt:1.5}}>
            {dispatchBlockedReason}
          </Alert>}
          <Divider sx={{my:1.5}}/>
          <TextField label="Bypass deviation threshold (m)" size="small" type="number"
            inputProps={{min:.01,max:1,step:.01}}
            value={store.settings.bypassDetectionThresholdM}
            onChange={(event)=>store.setSettings({
              bypassDetectionThresholdM:Number(event.target.value),
            })}/>
          <Stack direction="row" gap={1} mt={1}>
            <Button size="small" onClick={store.resetSession}>Reset route session</Button>
            <Button size="small" color="error" onClick={store.clearResults}>Clear results</Button>
          </Stack>
        </Paper>
        <Box sx={{flex:1,minWidth:0}}>
          <Typography variant="overline">Test results</Typography>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead><TableRow>
                <TableCell>Variant</TableCell><TableCell>Status</TableCell>
                <TableCell>Accepted</TableCell><TableCell>Corridor sent</TableCell>
                <TableCell>Corridor echoed</TableCell>
                <TableCell>Navigator path changed</TableCell><TableCell>Bypass detected</TableCell>
                <TableCell>Max deviation</TableCell><TableCell>Error</TableCell>
              </TableRow></TableHead>
              <TableBody>{store.results.map((result)=><TableRow key={result.id}>
                <TableCell>{corridorVariantLabels[result.variant]}</TableCell>
                <TableCell>{result.status}</TableCell>
                <TableCell>{result.acceptedAt?'Yes':'No'}</TableCell>
                <TableCell>{result.corridorSent?`Yes (${result.corridorCount})`:'No'}</TableCell>
                <TableCell>{result.navigatorCorridorEchoObserved?'Yes':'Not observed'}</TableCell>
                <TableCell>{result.navigatorPathChanged?'Yes':'No'}</TableCell>
                <TableCell>{result.bypassDetected?'Yes':'No'}</TableCell>
                <TableCell>{result.maximumLateralDeviationM.toFixed(3)} m</TableCell>
                <TableCell>{result.error??'—'}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </TableContainer>
        </Box>
      </Stack>
      <Typography variant="overline" sx={{display:'block',mt:2}}>Exact MQTT Payload Sent</Typography>
      {store.exactPayload?<Stack gap={1}>
        <Stack direction="row" gap={2} flexWrap="wrap">
          <Typography variant="caption">Topic: {store.exactPayload.topic}</Typography>
          <Typography variant="caption">Order: {store.exactPayload.orderId}</Typography>
          <Typography variant="caption">Header: {store.exactPayload.headerId}</Typography>
          <Typography variant="caption">Bytes: {store.exactPayload.payloadBytes}</Typography>
          <Typography variant="caption">Corridors: {store.exactPayload.corridorCount}</Typography>
          <Typography variant="caption">
            Raw contains corridor: {String(store.exactPayload.corridorExistsInRawPayload)}
          </Typography>
          <Typography variant="caption">
            Base VDA 2.0 validation: {String(store.exactPayload.baseVda20ValidationPassed)}
          </Typography>
          <Typography variant="caption">
            Corridor extension validation: {
              String(store.exactPayload.boschCorridorExtensionValidationPassed)}
          </Typography>
          <Typography variant="caption">
            Corridors after validation: {store.exactPayload.corridorCountAfterValidation}
          </Typography>
        </Stack>
        <TextField multiline minRows={8} maxRows={15} fullWidth
          value={store.exactPayload.rawJson}
          slotProps={{htmlInput:{readOnly:true,style:{fontFamily:'monospace',fontSize:12}}}}/>
      </Stack>:<Alert severity="info">No compatibility payload has been sent in this session.</Alert>}
      <Typography variant="overline" sx={{display:'block',mt:2}}>Operator procedure</Typography>
      <Typography component="ol" variant="body2" sx={{pl:2.5}}>
        <li>Place the same box in the same position.</li>
        <li>Use this locked route for each variant.</li>
        <li>Start each test separately and clear the previous Order.</li>
        <li>Confirm localization, AUTOMATIC mode, safety hardware, and Motion Feedback.</li>
        <li>Do not move the box between variants.</li>
      </Typography>
      <Typography variant="overline" sx={{display:'block',mt:2}}>Structured evidence log</Typography>
      <Paper variant="outlined" sx={{p:1,maxHeight:220,overflow:'auto'}}>
        <Box component="pre" sx={{m:0,fontSize:11,whiteSpace:'pre-wrap'}}>
          {JSON.stringify(store.logs.slice(-100),null,2)}
        </Box>
      </Paper>
    </DialogContent>
    <DialogActions>
      <Button disabled={!store.results.length&&!store.exactPayload}
        onClick={()=>void navigator.clipboard.writeText(JSON.stringify({
          generatedAt:new Date().toISOString(),compatibilityReport:report,conclusion,
          exactMqttPayloadSent:store.exactPayload??null,results:store.results,logs:store.logs,
        },null,2))}>Copy evidence report</Button>
      <Button onClick={onClose}>Close</Button>
    </DialogActions>
  </Dialog>;
};
