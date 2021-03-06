import {
  Script,
  Data,
  Op,
} from 'cashc';
import { Utxo, OpReturn, OutputForBuilder } from './interfaces';
import { ScriptUtil, CryptoUtil } from './BITBOX';
import { P2PKH_OUTPUT_SIZE, VERSION_SIZE, LOCKTIME_SIZE } from './constants';
import {
  Reason,
  FailedTransactionError,
  FailedRequireError,
  FailedTimeCheckError,
  FailedSigCheckError,
} from './Errors';

export function getInputSize(script: Buffer): number {
  const scriptSize = script.byteLength;
  const varIntSize = scriptSize > 252 ? 3 : 1;
  return 32 + 4 + varIntSize + scriptSize + 4;
}

export function getPreimageSize(script: Buffer): number {
  const scriptSize = script.byteLength;
  const varIntSize = scriptSize > 252 ? 3 : 1;
  return 4 + 32 + 32 + 36 + varIntSize + scriptSize + 8 + 4 + 32 + 4 + 4;
}

export function getTxSizeWithoutInputs(outputs: OutputForBuilder[]): number {
  // Transaction format:
  // Version (4 Bytes)
  // TxIn Count (1 ~ 9B)
  // For each TxIn:
  //   Outpoint (36B)
  //   Script Length (1 ~ 9B)
  //   ScriptSig(?)
  //   Sequence (4B)
  // TxOut Count (1 ~ 9B)
  // For each TxOut:
  //   Value (8B)
  //   Script Length(1 ~ 9B)*
  //   Script (?)*
  // LockTime (4B)

  let size = VERSION_SIZE + LOCKTIME_SIZE;
  size += outputs.reduce((acc, output) => {
    if (typeof output.to === 'string') {
      return acc + P2PKH_OUTPUT_SIZE;
    } else {
      // Size of an OP_RETURN output = byteLength + 8 (amount) + 2 (scriptSize)
      return acc + output.to.byteLength + 8 + 2;
    }
  }, 0);
  // Add txout count (accounting for a potential change output)
  size += Data.encodeInt(outputs.length + 1).byteLength;

  return size;
}

export function createInputScript(
  redeemScript: Script,
  encodedParameters: Buffer[],
  selector?: number,
  preimage?: Buffer,
): Buffer {
  // Create unlock script / redeemScriptSig
  const unlockScript = encodedParameters.reverse();
  if (preimage !== undefined) unlockScript.push(preimage);
  if (selector !== undefined) unlockScript.push(Data.encodeInt(selector));

  // Create total input script / scriptSig
  return ScriptUtil.encodeP2SHInput(
    ScriptUtil.encode(unlockScript),
    ScriptUtil.encode(redeemScript),
  );
}

export function createOpReturnOutput(
  opReturnOutput: OpReturn,
): OutputForBuilder {
  const script = [
    Op.OP_RETURN,
    ...opReturnOutput.opReturn.map((output: string) => toBuffer(output)),
  ];

  return { to: encodeNullDataScript(script), amount: 0 };
}

function toBuffer(output: string): Buffer {
  const data = output.replace(/^0x/, '');
  const format = data === output ? 'utf8' : 'hex';
  return Buffer.from(data, format);
}

export function meep(tx: any, utxos: Utxo[], script: Script): string {
  const scriptPubkey: string = ScriptUtil.encodeP2SHOutput(
    CryptoUtil.hash160(
      ScriptUtil.encode(script),
    ),
  ).toString('hex');
  return `meep debug --tx=${tx.toHex()} --idx=0 --amt=${utxos[0].satoshis} --pkscript=${scriptPubkey}`;
}


export function countOpcodes(script: Script): number {
  return script
    .filter(opOrData => typeof opOrData === 'number')
    .filter(op => op > Op.OP_16)
    .length;
}

export function calculateBytesize(script: Script): number {
  return ScriptUtil.encode(script).byteLength;
}

export function buildError(reason: string, meepStr: string): FailedTransactionError {
  const require = [
    Reason.EVAL_FALSE, Reason.VERIFY, Reason.EQUALVERIFY, Reason.CHECKMULTISIGVERIFY,
    Reason.CHECKSIGVERIFY, Reason.CHECKDATASIGVERIFY, Reason.NUMEQUALVERIFY,
  ];
  const timeCheck = [Reason.NEGATIVE_LOCKTIME, Reason.UNSATISFIED_LOCKTIME];
  const sigCheck = [
    Reason.SIG_COUNT, Reason.PUBKEY_COUNT, Reason.SIG_HASHTYPE, Reason.SIG_DER,
    Reason.SIG_HIGH_S, Reason.SIG_NULLFAIL, Reason.SIG_BADLENGTH, Reason.SIG_NONSCHNORR,
  ];
  if (toRegExp(require).test(reason)) {
    return new FailedRequireError(reason, meepStr);
  } else if (toRegExp(timeCheck).test(reason)) {
    return new FailedTimeCheckError(reason, meepStr);
  } else if (toRegExp(sigCheck).test(reason)) {
    return new FailedSigCheckError(reason, meepStr);
  } else {
    return new FailedTransactionError(reason, meepStr);
  }
}

function toRegExp(reasons: string[]): RegExp {
  return new RegExp(reasons.join('|').replace(/\(/g, '\\(').replace(/\)/g, '\\)'));
}

// ////////////////////////////////////////////////////////////////////////////
// For encoding OP_RETURN data (doesn't require BIP62.3)
// These functions are a mashup between those found in these libs:
// - https://github.com/simpleledger/slpjs/blob/master/lib/utils.ts
// - https://github.com/Bitcoin-com/bitcoincashjs-lib/blob/master/src/script.js

function encodeNullDataScript(chunks: (number | Buffer)[]): Buffer {
  const bufferSize = chunks.reduce((acc: number, chunk: number | Buffer) => {
    if (Buffer.isBuffer(chunk)) {
      const pushdataOpcode = getPushDataOpcode(chunk);
      return acc + chunk.length + pushdataOpcode.length;
    }
    return acc + 1;
  }, 0);

  const buffer = Buffer.allocUnsafe(bufferSize);
  let offset = 0;

  chunks.forEach((chunk: number | Buffer) => {
    if (Buffer.isBuffer(chunk)) {
      const pushdataOpcode = getPushDataOpcode(chunk);
      pushdataOpcode.copy(buffer, offset);
      offset += pushdataOpcode.length;

      chunk.copy(buffer, offset);
      offset += chunk.length;
    } else {
      buffer.writeUInt8(chunk, offset);
      offset += 1;
    }
  });

  return buffer;
}

function getPushDataOpcode(data: Buffer): Buffer {
  const { length } = data;

  if (length === 0) return Buffer.from([0x4c, 0x00]);
  if (length < 76) return Buffer.from([length]);
  if (length < 256) return Buffer.from([0x4c, length]);
  throw Error('Pushdata too large');
}
// ////////////////////////////////////////////////////////////////////////////
