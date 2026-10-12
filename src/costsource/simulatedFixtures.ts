// Bundled fixture data for the simulated connector cards (anonymous demo path); data only, no logic.
// AWS and Azure: the C1 documented-format sample exports in fixtures/connector-formats/, copied byte for
// byte minus their # provenance lines (a test pins the copy); see those files for what is verified.
// The rest: ILLUSTRATIVE payloads from the 2026-10-11 connector research. Their formats are NOT verified
// against any vendor (OpenCost core has no FOCUS export; no documented Nutanix cost API was found;
// PointFive tool shapes are assumed). All ids and values are synthetic; resource ids use a non-Ratio
// prefix (synthetic://) so simulated rows never resolve to a Ratio workload.

export const AWS_FOCUS_1_0_CSV = `AvailabilityZone,BilledCost,BillingAccountId,BillingAccountName,BillingCurrency,BillingPeriodEnd,BillingPeriodStart,ChargeCategory,ChargeClass,ChargeDescription,ChargeFrequency,ChargePeriodEnd,ChargePeriodStart,CommitmentDiscountCategory,CommitmentDiscountId,CommitmentDiscountName,CommitmentDiscountStatus,CommitmentDiscountType,ConsumedQuantity,ConsumedUnit,ContractedCost,ContractedUnitPrice,EffectiveCost,InvoiceIssuerName,ListCost,ListUnitPrice,PricingCategory,PricingQuantity,PricingUnit,ProviderName,PublisherName,RegionId,RegionName,ResourceId,ResourceName,ResourceType,ServiceCategory,ServiceName,SkuId,SkuPriceId,SubAccountId,SubAccountName,Tags,x_CostCategories,x_Discounts,x_Operation,x_ServiceCode,x_UsageType
us-east-1a,0.3400000000,synthetic-aws-billing-0001,Synthetic Payer,USD,2026-10-01T00:00:00Z,2026-09-01T00:00:00Z,Usage,,"$0.34 per On Demand Linux m5.large Instance Hour",Usage-Based,2026-09-14T04:00:00Z,2026-09-14T03:00:00Z,,,,,,1.0000000000,Hrs,0.3400000000,0.3400000000,0.3400000000,"Amazon Web Services, Inc.",0.3400000000,0.3400000000,Standard,1.0000000000,Hrs,AWS,"Amazon Web Services, Inc.",us-east-1,US East (N. Virginia),arn:aws:ec2:us-east-1:synthetic-aws-linked-0001:instance/i-synthetic0001,,Instance,Compute,Amazon Elastic Compute Cloud,SYNTHSKU0001,SYNTHSKU0001.SYNTHRATE01.SYNTHTERM01,synthetic-aws-linked-0001,Synthetic Linked Account,"{""team"":""payments"",""env"":""prod""}",,,RunInstances,AmazonEC2,BoxUsage:m5.large
,0.0000023000,synthetic-aws-billing-0001,Synthetic Payer,USD,2026-10-01T00:00:00Z,2026-09-01T00:00:00Z,Usage,,"$0.023 per GB-Mo of storage used - first 50 TB",Usage-Based,2026-09-14T04:00:00Z,2026-09-14T03:00:00Z,,,,,,0.1000000000,GB-Mo,0.0000023000,0.0230000000,0.0000023000,"Amazon Web Services, Inc.",0.0000023000,0.0230000000,Standard,0.1000000000,GB-Mo,AWS,"Amazon Web Services, Inc.",us-east-1,US East (N. Virginia),arn:aws:s3:::synthetic-bucket-0001,,Bucket,Storage,Amazon Simple Storage Service,SYNTHSKU0002,SYNTHSKU0002.SYNTHRATE01.SYNTHTERM01,synthetic-aws-linked-0001,Synthetic Linked Account,,,,StandardStorage,AmazonS3,TimedStorage-ByteHrs
,-1.2500000000,synthetic-aws-billing-0001,Synthetic Payer,USD,2026-10-01T00:00:00Z,2026-09-01T00:00:00Z,Credit,,"Synthetic promotional credit",One-Time,2026-09-30T23:00:00Z,2026-09-01T00:00:00Z,,,,,,,,0.0000000000,,-1.2500000000,"Amazon Web Services, Inc.",0.0000000000,,,,,AWS,"Amazon Web Services, Inc.",,,,,,Other,Synthetic Credits,,,synthetic-aws-linked-0001,Synthetic Linked Account,,,,,,
`;

export const AZURE_FOCUS_1_0_CSV = `BilledCost,BillingAccountId,BillingAccountName,BillingAccountType,BillingCurrency,BillingPeriodEnd,BillingPeriodStart,ChargeCategory,ChargeClass,ChargeDescription,ChargeFrequency,ChargePeriodEnd,ChargePeriodStart,ConsumedQuantity,ConsumedUnit,ContractedCost,ContractedUnitPrice,EffectiveCost,InvoiceIssuerName,ListCost,ListUnitPrice,PricingCategory,PricingQuantity,PricingUnit,ProviderName,PublisherName,RegionId,RegionName,ResourceId,ResourceName,ResourceType,ServiceCategory,ServiceName,SkuId,SkuPriceId,SubAccountId,SubAccountName,SubAccountType,Tags,x_BilledCostInUsd,x_ResourceGroupName,x_SkuMeterId,x_PricingCurrency,x_InvoiceId,x_SkuMeterName
12.480000000000,synthetic-ba-0001,Synthetic Billing Account,Billing Account,USD,2026-11-01T00:00Z,2026-10-01T00:00Z,Usage,,Synthetic D4s v5 Linux VM usage,Usage-Based,2026-10-02T00:00Z,2026-10-01T00:00Z,24.0,Hours,12.480000000000,0.52,12.480000000000,Microsoft,12.480000000000,0.52,Standard,24.0,1 Hour,Microsoft,Microsoft,eastus,East US,/subscriptions/00000000-0000-0000-0000-0000000000s1/resourcegroups/synthetic-rg/providers/microsoft.compute/virtualmachines/synthetic-vm-01,synthetic-vm-01,Virtual machine,Compute,Virtual Machines,synthetic-sku-0001,synthetic-skuprice-0001,/subscriptions/00000000-0000-0000-0000-0000000000s1,Synthetic Subscription,Subscription,"{""env"":""prod"",""team"":""synthetic-platform""}",12.480000000000,synthetic-rg,00000000-0000-0000-0000-00000000m001,USD,,D4s v5
0.000000000000,synthetic-ba-0001,Synthetic Billing Account,Billing Account,USD,2026-11-01T00:00Z,2026-10-01T00:00Z,Purchase,,Synthetic Marketplace subscription,One-Time,2026-10-02T00:00Z,2026-10-01T00:00Z,1.0,Each,0.000000000000,0.0,0.000000000000,Microsoft,0.000000000000,0.0,,1.0,Each,Microsoft,Synthetic Publisher,,,/subscriptions/00000000-0000-0000-0000-0000000000s1/resourcegroups/synthetic-rg/providers/microsoft.saas/resources/synthetic-saas-01,synthetic-saas-01,,Business,,,,/subscriptions/00000000-0000-0000-0000-0000000000s1,Synthetic Subscription,Subscription,,0.000000000000,synthetic-rg,,USD,,
-3.250000000000,synthetic-ba-0001,Synthetic Billing Account,Billing Account,USD,2026-11-01T00:00Z,2026-10-01T00:00Z,Credit,Correction,Synthetic Azure credit,One-Time,2026-10-03T00:00Z,2026-10-02T00:00Z,,,,,-3.250000000000,Microsoft,,,,,,Microsoft,Microsoft,,,,,,,,,,/subscriptions/00000000-0000-0000-0000-0000000000s1,Synthetic Subscription,Subscription,,-3.250000000000,,,USD,,
`;

const K8S_ROW = {
  BillingCurrency: 'USD', BillingPeriodStart: '2026-10-01T00:00:00Z', BillingPeriodEnd: '2026-11-01T00:00:00Z',
  ChargePeriodStart: '2026-10-01T00:00:00Z', ChargePeriodEnd: '2026-10-02T00:00:00Z', BillingAccountId: 'demo-cluster-01',
  ServiceName: 'Kubernetes Namespace', ServiceCategory: 'Compute', ProviderName: 'OpenCost', ChargeCategory: 'Usage',
  PricingQuantity: 1440, PricingUnit: 'Minutes', UsageUnit: 'CPU Core-Hours',
};

/** ILLUSTRATIVE: OpenCost namespace allocation mapped to FOCUS 1.0 rows (the mapping is a proposal). */
export const KUBERNETES_FOCUS_ROWS = [
  { ...K8S_ROW, BilledCost: 3.7, EffectiveCost: 3.7, SubAccountId: 'payments', ChargeDescription: 'payments namespace allocation', ResourceId: 'synthetic://workload/wl-demo-001', UsageQuantity: 48 },
  { ...K8S_ROW, BilledCost: 8.35, EffectiveCost: 8.35, SubAccountId: 'search', ChargeDescription: 'search namespace allocation', ResourceId: 'k8s://demo-cluster-01/search', UsageQuantity: 0 },
];

/** ILLUSTRATIVE: the FOCUS 1.0 CSV our Nutanix connector assumes; no such Nutanix export is documented. */
export const NUTANIX_FOCUS_CSV = `BilledCost,EffectiveCost,BillingCurrency,BillingPeriodStart,BillingPeriodEnd,ChargePeriodStart,ChargePeriodEnd,BillingAccountId,SubAccountId,ServiceName,ServiceCategory,ProviderName,ChargeCategory,ChargeDescription,ResourceId,PricingQuantity,PricingUnit,ConsumedQuantity,ConsumedUnit
41.250000,41.250000,USD,2026-10-01T00:00:00Z,2026-11-01T00:00:00Z,2026-10-01T00:00:00Z,2026-10-02T00:00:00Z,synthetic-ntnx-org-01,synthetic-ntnx-cluster-01,Synthetic Nutanix AHV Compute,Compute,Nutanix,Usage,Synthetic VM showback (cpu+memory),synthetic-ntnx-vm-0001,24,Hour,24,Hour
18.900000,18.900000,USD,2026-10-01T00:00:00Z,2026-11-01T00:00:00Z,2026-10-01T00:00:00Z,2026-10-02T00:00:00Z,synthetic-ntnx-org-01,synthetic-ntnx-cluster-01,Synthetic Nutanix Storage,Storage,Nutanix,Usage,Synthetic storage container showback,synthetic-ntnx-sc-0001,512,GB-Day,512,GB-Day
`;

/** ILLUSTRATIVE: PointFive MCP tool results (billing, opportunities, anomalies); tool names and fields assumed. */
export const POINTFIVE_BILLING_ROWS = [
  { ...K8S_ROW, BilledCost: '412.18', EffectiveCost: '412.18', BillingAccountId: 'synthetic-p5-account-01', SubAccountId: 'synthetic-p5-sub-01', ServiceName: 'Amazon EC2', ProviderName: 'AWS', ChargeDescription: 'Synthetic EC2 usage', ResourceId: 'synthetic://workload/wl-demo-003', PricingQuantity: 24, PricingUnit: 'Hours', UsageQuantity: 24, UsageUnit: 'Hours' },
];
export const POINTFIVE_OPPORTUNITIES = [
  { id: 'opp-demo-0001', resourceId: 'synthetic://workload/wl-demo-001', category: 'idle_resource', title: 'Idle load balancer demo-lb-01', estimatedMonthlySavings: 182.5, severity: 'warning' as const, detectedAt: '2026-10-03T08:15:00Z' },
  { id: 'opp-demo-0002', resourceId: 'arn:aws:ec2:us-east-1:111122223333:instance/i-0demo000000001', category: 'rightsizing', title: 'Downsize m5.4xlarge to m5.2xlarge', estimatedMonthlySavings: 410, severity: 'info' as const, detectedAt: '2026-10-04T11:00:00Z' },
];
export const POINTFIVE_ANOMALIES = [
  { id: 'anom-demo-0001', resourceId: 'synthetic://workload/wl-demo-002', category: 'spend_drop', title: 'Spend drop on demo-bucket-egress', observedSpendDelta: -95.2, severity: 'critical' as const, detectedAt: '2026-10-05T02:30:00Z' },
];
