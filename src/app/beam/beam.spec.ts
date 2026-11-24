import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Beam } from './beam';

describe('Beam', () => {
  let component: Beam;
  let fixture: ComponentFixture<Beam>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Beam],
      providers: [provideZonelessChangeDetection()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Beam);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
