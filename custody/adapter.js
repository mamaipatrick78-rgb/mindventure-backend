// Custody abstraction. Never put private keys in PostgreSQL or the API.
// Replace MockCustody with a regulated/approved custody provider adapter.
export class CustodyAdapter{
 async createDepositAddress(){throw new Error('CUSTODY_PROVIDER_NOT_CONFIGURED')}
 async createWithdrawal(){throw new Error('CUSTODY_PROVIDER_NOT_CONFIGURED')}
 async getTransaction(){throw new Error('CUSTODY_PROVIDER_NOT_CONFIGURED')}
}
export class MockCustody extends CustodyAdapter{
 async createDepositAddress({asset,network,userId}){return {providerRef:`demo-${userId}-${asset}-${network}`,address:`DEMO_${asset}_${network}_ADDRESS`}}
 async createWithdrawal(){return {providerRef:'demo-withdrawal',status:'pending'}}
 async getTransaction(){return null}
}
export function custody(){return new MockCustody()}
