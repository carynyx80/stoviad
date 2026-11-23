#![allow(dead_code, unused_imports)]

use borsh::BorshSerialize;
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_sdk::{
    account::Account,
    bpf_loader_upgradeable,
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program, sysvar,
    transaction::Transaction,
};
use std::str::FromStr;

pub const SOL: u64 = 1_000_000_000;

pub fn pid() -> Pubkey {
    Pubkey::from_str("6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8").unwrap()
}
pub fn disc(name: &str) -> Vec<u8> {
    Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec()
}
pub fn ix(name: &str, args: impl BorshSerialize, accounts: Vec<AccountMeta>) -> Instruction {
    let mut data = disc(name);
    args.serialize(&mut data).unwrap();
    Instruction { program_id: pid(), accounts, data }
}
pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &pid()).0
}
pub fn w(k: Pubkey) -> AccountMeta {
    AccountMeta::new(k, false)
}
pub fn r(k: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}
pub fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &signers, svm.latest_blockhash());
    match svm.send_transaction(tx) {
        Ok(_) => {}
        Err(e) => panic!("tx failed: {:?}\nlogs:\n{}", e.err, e.meta.logs.join("\n")),
    }
    svm.expire_blockhash();
}
pub fn bal(svm: &LiteSVM, k: &Pubkey) -> u64 {
    svm.get_balance(k).unwrap_or(0)
}
pub fn token_amount(svm: &LiteSVM, k: &Pubkey) -> u64 {
    let a = svm.get_account(k).unwrap();
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}
pub fn set_time(svm: &mut LiteSVM, ts: i64) {
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp = ts;
    c.slot += 1;
    svm.set_sysvar(&c);
}

/// Deploy as an upgradeable program so initialize_config's upgrade-authority gate works.
pub fn deploy(svm: &mut LiteSVM, authority: &Pubkey) {
    // litesvm 0.6 (agave 2.2 runtime) only loads SBPF v0-v2; build with
    // `cargo build-sbf --arch v0 --sbf-out-dir target/deploy-v0`, or point STOVIA_SO at a .so.
    let path = std::env::var("STOVIA_SO")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy-v0/stovia.so").to_string());
    let elf = std::fs::read(&path).expect("missing program .so (see comment)");
    let (pd, _) = Pubkey::find_program_address(&[pid().as_ref()], &bpf_loader_upgradeable::id());
    let mut pd_data = vec![3u8, 0, 0, 0];
    pd_data.extend_from_slice(&0u64.to_le_bytes());
    pd_data.push(1);
    pd_data.extend_from_slice(authority.as_ref());
    pd_data.extend_from_slice(&elf);
    svm.set_account(pd, Account { lamports: 10 * SOL, data: pd_data, owner: bpf_loader_upgradeable::id(), executable: false, rent_epoch: 0 })
        .unwrap();
    let mut p_data = vec![2u8, 0, 0, 0];
    p_data.extend_from_slice(pd.as_ref());
    svm.set_account(pid(), Account { lamports: SOL, data: p_data, owner: bpf_loader_upgradeable::id(), executable: true, rent_epoch: 0 })
        .unwrap();
}


/// Like `send` but returns Err(logs) instead of panicking; always expires the blockhash.
pub fn try_send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> Result<(), String> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &signers, svm.latest_blockhash());
    let res = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    svm.expire_blockhash();
    res
}

pub fn programdata() -> Pubkey {
    Pubkey::find_program_address(&[pid().as_ref()], &bpf_loader_upgradeable::id()).0
}

pub fn init_config_ix(admin: &Pubkey, treasury: Pubkey, pending: Option<Pubkey>, resolver: Pubkey) -> Instruction {
    ix(
        "initialize_config",
        (treasury, 10u16, 10u16, pending, resolver),
        vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new(pda(&[b"config"]), false),
            AccountMeta::new_readonly(pid(), false),
            AccountMeta::new_readonly(programdata(), false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
    )
}

/// Decoded Config (Borsh: Option<Pubkey> None is 1 byte, so offsets shift).
pub struct ConfigView {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub pending_admin: Option<Pubkey>,
    pub resolver: Pubkey,
}
pub fn read_config(svm: &LiteSVM) -> ConfigView {
    let d = svm.get_account(&pda(&[b"config"])).unwrap().data;
    let pk = |o: usize| Pubkey::try_from(&d[o..o + 32]).unwrap();
    let (pending_admin, ro) = if d[85] == 1 { (Some(pk(86)), 118) } else { (None, 86) };
    ConfigView { admin: pk(8), treasury: pk(40), pending_admin, resolver: pk(ro) }
}

pub struct LaunchKeys {
    pub mint: Keypair,
    pub launch: Pubkey,
    pub curve_vault: Pubkey,
    pub curve_sol: Pubkey,
    pub bond_vault: Pubkey,
    pub fee_vault: Pubkey,
    pub market: Pubkey,
    pub market_vault: Pubkey,
}

pub fn launch(svm: &mut LiteSVM, creator: &Keypair, treasury: Pubkey, bond: u64, target: u64, deadline: i64) -> LaunchKeys {
    let mint = Keypair::new();
    let launch = pda(&[b"launch", mint.pubkey().as_ref()]);
    let k = LaunchKeys {
        curve_vault: pda(&[b"curve_vault", launch.as_ref()]),
        curve_sol: pda(&[b"curve_sol", launch.as_ref()]),
        bond_vault: pda(&[b"bond", launch.as_ref()]),
        fee_vault: pda(&[b"creator_fee", launch.as_ref()]),
        market: pda(&[b"market", launch.as_ref()]),
        market_vault: pda(&[b"market_vault", launch.as_ref()]),
        launch,
        mint,
    };
    send(
        svm,
        &[ix(
            "launch_token",
            ("Survivor".to_string(), "SRV".to_string(), "https://x/s.json".to_string(), bond, target, deadline),
            vec![
                AccountMeta::new(creator.pubkey(), true),
                w(pda(&[b"config"])),
                w(treasury),
                AccountMeta::new(k.mint.pubkey(), true),
                w(k.launch),
                w(k.curve_vault),
                w(k.curve_sol),
                w(k.bond_vault),
                w(k.fee_vault),
                w(k.market),
                w(k.market_vault),
                r(spl_token::id()),
                r(system_program::id()),
            ],
        )],
        creator,
        &[&k.mint],
    );
    k
}

pub fn side_commitment(side: u8, salt: [u8; 32], bettor: &Pubkey) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([side]);
    h.update(salt);
    h.update(bettor.as_ref());
    h.finalize().into()
}
pub fn stake_commitment(amount: u64, salt2: [u8; 32], bettor: &Pubkey) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(amount.to_le_bytes());
    h.update(salt2);
    h.update(bettor.as_ref());
    h.finalize().into()
}
